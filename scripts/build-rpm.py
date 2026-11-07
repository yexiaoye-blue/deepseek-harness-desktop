import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile

DEPENDENCIES = ['gtk3', 'libappindicator-gtk3', 'alsa-lib', 'nss', 'mesa-libgbm', 'libdrm', 'libX11', 'libXcomposite', 'libXdamage', 'libXrandr', 'libXtst', 'libXScrnSaver', 'cups-libs', 'dbus-libs', 'at-spi2-atk', 'pango', 'glib2', 'openssl-libs', 'zenity']
MARKER = '/* dsh-rpm-linux-branding:v1 */'


def identity(root, release):
    root = Path(root).resolve()
    config = json.loads((root / 'apps/desktop/src-tauri/tauri.conf.json').read_text())
    version = json.loads((root / 'package.json').read_text())['version']
    cargo = (root / 'apps/desktop/src-tauri/Cargo.toml').read_text().split('[package]', 1)[1].split('\n[', 1)[0]
    cargo_version = re.search(r'^version\s*=\s*"([^"]+)"', cargo, re.M)
    if not cargo_version or {version, config['version'], cargo_version[1]} != {version}:
        raise ValueError('RPM_VERSION_MISMATCH: package, Cargo and Tauri versions must match')
    match = re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?', version)
    if not match or not re.fullmatch(r'[0-9][0-9A-Za-z.]*', release):
        raise ValueError('RPM_VERSION_INVALID: invalid source version or RPM release')
    if match[5] and any(not part for part in match[5].split('.')):
        raise ValueError('RPM_VERSION_INVALID: invalid build metadata')
    product = config['productName']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 ._]*', product):
        raise ValueError('RPM_PRODUCT_INVALID: unsupported product name')
    rpm_version = '.'.join(match.group(i) for i in (1, 2, 3))
    if match[4]:
        for part in match[4].split('.'):
            if not part or (part.isdigit() and len(part) > 1 and part.startswith('0')):
                raise ValueError('RPM_VERSION_INVALID: invalid prerelease identifier')
        rpm_version += '~' + match[4].replace('-', '.')
    return {'name': 'dsh-tauri', 'source_version': version, 'version': rpm_version, 'release': release, 'product': product, 'binary': 'deepseek-harness-desktop'}


def brand(entry, product):
    original = entry.read_text()
    if original.startswith(MARKER):
        return
    if 'require("electron")' not in original and "require('electron')" not in original:
        raise ValueError('RPM_RUNTIME_INVALID: unrecognized Electron entry')
    settings = json.dumps({'name': product, 'desktopFile': product + '.desktop', 'wmClass': 'deepseek-harness-desktop'})
    bootstrap = r''';(() => {
  if (process.platform !== 'linux') return;
  const { app } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const identity = IDENTITY;
  process.env.ELECTRON_RS_APP_NAME = identity.name;
  app.setName(identity.name);
  app.setDesktopName(identity.desktopFile);
  app.commandLine.appendSwitch('class', identity.wmClass);
  const icon = path.resolve(__dirname, '../../icons/app.png');
  if (fs.existsSync(icon)) app.on('browser-window-created', (_event, window) => window.setIcon(icon));
})();
'''.replace('IDENTITY', settings)
    entry.write_text(MARKER + '\n' + bootstrap + original)


def stage(root, destination, release):
    root, destination = Path(root).resolve(), Path(destination).resolve()
    meta = identity(root, release)
    tauri = root / 'apps/desktop/src-tauri'
    resources = destination / 'usr/lib' / meta['product']
    binary = destination / 'usr/bin' / meta['binary']
    binary.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(tauri / 'target/release' / meta['binary'], binary)
    binary.chmod(0o755)
    resources.mkdir(parents=True, exist_ok=True)
    shutil.copytree(tauri / 'resources', resources / 'resources')
    shutil.copytree(tauri / 'target/electron', resources / 'runtime')
    entries = sorted((resources / 'runtime').glob('linux-*/main.cjs'))
    helpers = sorted((resources / 'runtime').glob('linux-*/chrome-sandbox'))
    if not entries or not helpers:
        raise ValueError('RPM_RUNTIME_MISSING: Electron entry or sandbox helper not found')
    for entry in entries:
        brand(entry, meta['product'])
    for helper in helpers:
        helper.chmod(0o4755)
    for source, size in [('32x32.png', 32), ('128x128.png', 128), ('128x128@2x.png', 256), ('icon.png', 512)]:
        target = destination / f'usr/share/icons/hicolor/{size}x{size}/apps' / (meta['binary'] + '.png')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(tauri / 'icons' / source, target)
    (resources / 'icons').mkdir()
    shutil.copy2(tauri / 'icons/icon.png', resources / 'icons/app.png')
    shutil.copy2(tauri / 'icons/32x32.png', resources / 'icons/32x32.png')
    notices = resources / 'licenses/upstream'
    notices.mkdir(parents=True)
    for name in ['LICENSE', 'LICENSE.details', 'THIRD_PARTY_NOTICES.md']:
        shutil.copy2(root / name, notices / name)
    applications = destination / 'usr/share/applications'
    applications.mkdir(parents=True)
    (applications / (meta['product'] + '.desktop')).write_text('\n'.join([
        '[Desktop Entry]', 'Categories=Development;', 'Comment=Desktop application for DeepSeek Harness (dsh)',
        'Exec=' + meta['binary'], 'StartupWMClass=' + meta['binary'], 'Icon=' + meta['binary'],
        'Name=' + meta['product'], 'Terminal=false', 'Type=Application', 'MimeType=x-scheme-handler/dsh;', '',
    ]))
    return meta


def build(root, release, output):
    root, output = Path(root).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='dsh-rpm-') as temp:
        work = Path(temp)
        payload = work / 'payload'
        meta = stage(root, payload, release)
        spec = (root / 'packaging/rpm/package.spec.in').read_text()
        for key in ['name', 'version', 'release', 'product', 'binary']:
            spec = spec.replace('@' + key.upper() + '@', meta[key])
        spec = spec.replace('@DEPENDS@', '\n'.join('Requires: ' + dep for dep in DEPENDENCIES))
        spec = spec.replace('@PAYLOAD@', str(payload))
        spec_file = work / 'package.spec'
        spec_file.write_text(spec)
        subprocess.run(['rpmbuild', '-bb', '--define', '_topdir ' + str(work / 'rpmbuild'), '--define', '_rpmdir ' + str(output), str(spec_file)], check=True)
    return meta


def glibc_requirement(output):
    needs = False
    versions = []
    for line in output.splitlines():
        if 'Version needs section' in line:
            needs = True
        elif re.match(r'Version (definition|symbols) section', line):
            needs = False
        if needs:
            versions.extend(tuple(map(int, m.split('.'))) for m in re.findall(r'Name: GLIBC_(\d+(?:\.\d+)+)\b', line))
    return max(versions, default=(0, 0))


def verify(root, source, arch, release, destination, sha):
    meta = identity(root, release)
    if arch not in ('x86_64', 'aarch64') or not re.fullmatch(r'[a-f0-9]{40}', sha or ''):
        raise ValueError('RPM_PROVENANCE_INVALID: expected architecture and full source SHA')
    candidates = list(Path(source).rglob('*.rpm'))
    if len(candidates) != 1:
        raise ValueError('RPM_OUTPUT_INVALID: expected exactly one RPM')
    artifact = candidates[0].resolve()
    fields = subprocess.check_output(['rpm', '-qp', '--queryformat', '%{NAME}\n%{VERSION}\n%{RELEASE}\n%{ARCH}\n', str(artifact)], text=True).splitlines()
    if fields != [meta['name'], meta['version'], release, arch]:
        raise ValueError('RPM_IDENTITY_INVALID: ' + repr(fields))
    permissions = subprocess.check_output(['rpm', '-qp', '--queryformat', '[%{FILENAMES}\t%{FILEMODES:octal}\t%{FILEUSERNAME}\t%{FILEGROUPNAME}\n]', str(artifact)], text=True).splitlines()
    helpers = [line.split('\t') for line in permissions if line.split('\t')[0].endswith('/chrome-sandbox')]
    if not helpers or any(int(mode, 8) & 0o7777 != 0o4755 or user != 'root' or group != 'root' for _, mode, user, group in helpers):
        raise ValueError('RPM_SANDBOX_INVALID: expected root-owned setuid sandbox')
    with tempfile.TemporaryDirectory(prefix='rpm-verify-') as temp:
        subprocess.run(['bsdtar', '--no-same-owner', '--no-same-permissions', '-xf', str(artifact), '-C', temp], check=True)
        resource = Path(temp) / 'usr/lib' / meta['product']
        for name in ['icons/app.png', 'licenses/upstream/LICENSE', 'licenses/upstream/LICENSE.details', 'licenses/upstream/THIRD_PARTY_NOTICES.md']:
            if not (resource / name).is_file():
                raise ValueError('RPM_RESOURCE_MISSING: ' + name)
        entries = list((resource / 'runtime').glob('linux-*/main.cjs'))
        if not entries or not all(entry.read_text().startswith(MARKER) for entry in entries):
            raise ValueError('RPM_BRANDING_MISSING: runtime identity not installed')
        desktop = (Path(temp) / 'usr/share/applications' / (meta['product'] + '.desktop')).read_text().splitlines()
        for line in ['Name=' + meta['product'], 'StartupWMClass=' + meta['binary'], 'Icon=' + meta['binary']]:
            if line not in desktop:
                raise ValueError('RPM_DESKTOP_INVALID: ' + line)
        expected_machine = {'x86_64': 62, 'aarch64': 183}[arch]
        highest, count = (0, 0), 0
        checked_roots = [Path(temp) / 'usr/bin', resource / 'runtime']
        for root in checked_roots:
            for file in root.rglob('*'):
                if not file.is_file() or file.is_symlink():
                    continue
                with file.open('rb') as stream:
                    header = stream.read(20)
                if header[:4] != b'\x7fELF':
                    continue
                if len(header) != 20 or header[4:6] != b'\x02\x01' or struct.unpack('<H', header[18:20])[0] != expected_machine:
                    raise ValueError('RPM_ELF_ARCH_INVALID: ' + str(file.relative_to(temp)))
                count += 1
                output = subprocess.check_output(['readelf', '--version-info', '--wide', str(file)], text=True, stderr=subprocess.DEVNULL)
                highest = max(highest, glibc_requirement(output))
        if not count or highest == (0, 0) or highest > (2, 35):
            raise ValueError('RPM_GLIBC_INVALID: ' + repr((count, highest)))
    dest = Path(destination)
    dest.mkdir(parents=True, exist_ok=True)
    filename = f"Deepseek.Harness.Desktop_{meta['source_version']}_{release}_{arch}.rpm"
    target = dest / filename
    shutil.copyfile(artifact, target)
    with target.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(stream.read()).hexdigest()
    data = {**meta, 'architecture': arch, 'source_sha': sha, 'filename': filename, 'sha256': digest, 'highest_glibc': '.'.join(map(str, highest)), 'elf_files_checked': count}
    (dest / f'BUILD-rpm-{arch}.json').write_text(json.dumps(data, indent=2) + '\n')
    (dest / f'SHA256SUMS-rpm-{arch}').write_text(f'{digest}  {filename}\n')
    print(json.dumps(data, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['build', 'verify'])
    parser.add_argument('--root', default='.')
    parser.add_argument('--release', default='2.github')
    parser.add_argument('--source', default='apps/desktop/src-tauri/target/release/bundle/rpm')
    parser.add_argument('--output', default='dist/rpm')
    parser.add_argument('--arch')
    parser.add_argument('--sha')
    args = parser.parse_args()
    if args.command == 'build':
        build(args.root, args.release, args.source)
    else:
        verify(args.root, args.source, args.arch, args.release, args.output, args.sha)
