import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import platform
import random
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('build-rpm.py')
SPEC = SCRIPT.parent.parent / 'packaging/rpm/package.spec.in'
loader = importlib.util.spec_from_file_location('rpm_packaging', SCRIPT)
rpm = importlib.util.module_from_spec(loader)
loader.loader.exec_module(rpm)


class PackagingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rpm-test-')
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.root = self.work / 'source'
        self.tauri = self.root / 'apps/desktop/src-tauri'
        self.tauri.mkdir(parents=True)
        self.version('0.31.0-beta.3+build.9')

    def version(self, value):
        (self.root / 'package.json').write_text(json.dumps({'version': value}))
        (self.tauri / 'tauri.conf.json').write_text(json.dumps({'version': value, 'productName': 'DSH Tauri'}))
        (self.tauri / 'Cargo.toml').write_text('[package]\nname = "deepseek-harness-desktop"\nversion = "' + value + '"\n')

    def fixture(self):
        runtime = self.tauri / 'target/electron' / ('linux-x64' if platform.machine() == 'x86_64' else 'linux-arm64')
        runtime.mkdir(parents=True)
        (runtime / 'main.cjs').write_text("require('electron'); globalThis.originalRan = true;\n")
        binary = self.tauri / 'target/release/deepseek-harness-desktop'
        binary.parent.mkdir(parents=True)
        subprocess.run(['cc', '-x', 'c', '-o', str(binary), '-'], input='int main(void) { return 0; }\n', text=True, check=True, timeout=30)
        shutil.copy2(binary, runtime / 'chrome-sandbox')
        (self.tauri / 'resources').mkdir()
        (self.tauri / 'resources/plugin.json').write_text('{"fixture":true}')
        (self.tauri / 'icons').mkdir()
        for name in ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png']:
            (self.tauri / 'icons' / name).write_bytes(b'fixture-' + name.encode())
        for name in ['LICENSE', 'LICENSE.details', 'THIRD_PARTY_NOTICES.md']:
            (self.root / name).write_text('fixture-' + name)
        spec = self.root / 'packaging/rpm/package.spec.in'
        spec.parent.mkdir(parents=True)
        shutil.copy2(SPEC, spec)
        return runtime

    def test_prerelease_and_stable_keep_rpm_upgrade_order(self):
        self.assertEqual(rpm.identity(self.root, '2.github.42')['version'], '0.31.0~beta.3')
        self.version('0.31.0')
        self.assertEqual(rpm.identity(self.root, '2.github.43')['version'], '0.31.0')
        order = subprocess.check_output(['rpm', '--eval', '%{lua:print(rpm.vercmp("0.31.0~beta.3", "0.31.0"))}'], text=True, timeout=30).strip()
        self.assertEqual(order, '-1')

    def test_invalid_or_inconsistent_versions_are_rejected(self):
        for value in ['01.2.3', '1.2.3-beta..1', '1.2.3-01', '1.2.3+build..1', '1.2.3\nRequires: injected']:
            with self.subTest(version=value):
                self.version(value)
                with self.assertRaisesRegex(ValueError, 'RPM_VERSION_INVALID'):
                    rpm.identity(self.root, '2.github')
        self.version('0.31.0')
        (self.root / 'package.json').write_text('{"version":"0.30.4"}')
        with self.assertRaisesRegex(ValueError, 'RPM_VERSION_MISMATCH'):
            rpm.identity(self.root, '2.github')

    def test_invalid_release_and_missing_provenance_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'RPM_VERSION_INVALID'):
            rpm.identity(self.root, '2\nRequires: injected')
        for arch, sha in [('x86_64', None), ('x86_64', 'short'), ('arm64', 'a' * 40)]:
            with self.subTest(arch=arch, sha=sha), self.assertRaisesRegex(ValueError, 'RPM_PROVENANCE_INVALID'):
                rpm.verify(self.root, self.work, arch, '2.github', self.work / 'dist', sha)

    def test_stage_copies_resources_without_modifying_source(self):
        runtime = self.fixture()
        original = (runtime / 'main.cjs').read_bytes()
        payload = self.work / 'payload'
        rpm.stage(self.root, payload, '2.github')
        resource = payload / 'usr/lib/DSH Tauri'
        self.assertEqual((runtime / 'main.cjs').read_bytes(), original)
        self.assertEqual((resource / 'resources/plugin.json').read_text(), '{"fixture":true}')
        self.assertEqual((resource / 'icons/app.png').read_bytes(), b'fixture-icon.png')
        for name in ['LICENSE', 'LICENSE.details', 'THIRD_PARTY_NOTICES.md']:
            self.assertEqual((resource / 'licenses/upstream' / name).read_text(), 'fixture-' + name)
        helper = resource / 'runtime' / runtime.name / 'chrome-sandbox'
        self.assertEqual(helper.stat().st_mode & 0o7777, 0o4755)
        self.assertEqual((payload / 'usr/bin/deepseek-harness-desktop').stat().st_mode & 0o777, 0o755)
        desktop = (payload / 'usr/share/applications/DSH Tauri.desktop').read_text().splitlines()
        self.assertIn('Name=DSH Tauri', desktop)
        self.assertIn('StartupWMClass=DSH Tauri', desktop)
        self.assertIn('Icon=deepseek-harness-desktop', desktop)
        self.assertNotIn('StartupWMClass=deepseek-harness-desktop', desktop)

    def test_missing_sandbox_stops_packaging(self):
        runtime = self.fixture()
        (runtime / 'chrome-sandbox').unlink()
        with self.assertRaisesRegex(ValueError, 'RPM_RUNTIME_MISSING'):
            rpm.stage(self.root, self.work / 'payload', '2.github')

    def test_branding_sets_linux_window_identity_and_icon_once(self):
        runtime = self.fixture()
        entry = runtime / 'main.cjs'
        rpm.brand(entry, 'DSH Tauri')
        first = entry.read_bytes()
        rpm.brand(entry, 'DSH Tauri')
        self.assertEqual(entry.read_bytes(), first)
        harness = r'''
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
for (const platform of ['linux', 'darwin']) {
  const calls = [], env = {};
  let created;
  const app = {
    setName: value => calls.push(['name', value]),
    setDesktopName: value => calls.push(['desktop', value]),
    commandLine: { appendSwitch: (...args) => calls.push(['switch', ...args]) },
    on: (event, callback) => { assert.equal(event, 'browser-window-created'); created = callback; },
  };
  const context = {
    process: { platform, env }, __dirname: '/opt/dsh/runtime/linux-x64',
    require: module => {
      if (module === 'electron') return { app };
      if (module === 'node:path') return require('node:path');
      if (module === 'node:fs') return { existsSync: file => file === '/opt/dsh/icons/app.png' };
      throw Error(module);
    },
  };
  vm.runInNewContext(source, context);
  assert.equal(context.originalRan, true);
  if (platform === 'linux') {
    assert.deepEqual(calls, [['name', 'DSH Tauri'], ['desktop', 'DSH Tauri.desktop']]);
    assert.equal(env.ELECTRON_RS_APP_NAME, 'DSH Tauri');
    let icon;
    created({}, { setIcon: value => { icon = value; } });
    assert.equal(icon, '/opt/dsh/icons/app.png');
  } else {
    assert.deepEqual(calls, []);
    assert.deepEqual(env, {});
    assert.equal(created, undefined);
  }
}
'''
        subprocess.run(['node', '-e', harness], input=json.dumps(entry.read_text()), text=True, check=True, timeout=30)
        entry.write_text('unknown entrypoint')
        with self.assertRaisesRegex(ValueError, 'RPM_RUNTIME_INVALID'):
            rpm.brand(entry, 'DSH Tauri')
        self.assertEqual(entry.read_text(), 'unknown entrypoint')

    def test_glibc_parser_counts_requirements_without_counting_definitions(self):
        output = '''Version needs section '.gnu.version_r' contains 1 entry:
  0x0010: Name: GLIBC_2.17 Flags: none
  0x0020: Name: GLIBC_2.35 Flags: none
Version definition section '.gnu.version_d' contains 1 entry:
  0x0030: Name: GLIBC_2.42 Flags: none
'''
        self.assertEqual(rpm.glibc_requirement(output), (2, 35))
        self.assertEqual(rpm.glibc_requirement(output.replace('GLIBC_2.35', 'GLIBC_2.36')), (2, 36))
        self.assertEqual(rpm.glibc_requirement('No version information found'), (0, 0))

    def test_incompatible_or_unsafe_rpm_is_rejected_before_publication(self):
        self.fixture()
        binary = self.tauri / 'target/release/deepseek-harness-desktop'
        original = binary.read_bytes()
        spec = self.root / 'packaging/rpm/package.spec.in'
        template = spec.read_text()
        for case, error in [('architecture', 'RPM_ELF_ARCH_INVALID'), ('glibc', 'RPM_GLIBC_INVALID'), ('permissions', 'RPM_SANDBOX_INVALID')]:
            with self.subTest(case=case):
                binary.write_bytes(original)
                spec.write_text(template)
                if case == 'architecture':
                    header = bytearray(original)
                    header[18:20] = (183 if platform.machine() == 'x86_64' else 62).to_bytes(2, 'little')
                    binary.write_bytes(header)
                elif case == 'glibc':
                    self.assertIn(b'GLIBC_2.34', original)
                    binary.write_bytes(original.replace(b'GLIBC_2.34', b'GLIBC_2.36'))
                else:
                    spec.write_text(template.replace('%defattr(-,root,root,-)', '%defattr(0755,root,root,-)'))
                output, destination = self.work / case, self.work / (case + '-published')
                rpm.build(self.root, '2.github.42', output)
                with self.assertRaisesRegex(ValueError, error):
                    rpm.verify(self.root, output, platform.machine(), '2.github.42', destination, 'a' * 40)
                self.assertFalse(destination.exists())

    def test_optional_foreign_frontend_native_module_does_not_fail_runtime_check(self):
        self.fixture()
        foreign = self.tauri / 'resources/node_modules/@tailwindcss/oxide-linux-arm64-gnu/tailwindcss-oxide.linux-arm64-gnu.node'
        foreign.parent.mkdir(parents=True)
        header = bytearray(64)
        header[:6] = b'\x7fELF\x02\x01'
        header[18:20] = (183 if platform.machine() == 'x86_64' else 62).to_bytes(2, 'little')
        foreign.write_bytes(header)
        output, destination = self.work / 'optional', self.work / 'optional-dist'
        rpm.build(self.root, '2.github.42', output)
        with contextlib.redirect_stdout(io.StringIO()):
            rpm.verify(self.root, output, platform.machine(), '2.github.42', destination, 'b' * 40)
        data = json.loads((destination / ('BUILD-rpm-' + platform.machine() + '.json')).read_text())
        self.assertEqual(data['elf_files_checked'], 2)

    def test_real_rpm_verification_publishes_checked_payload_and_checksum(self):
        self.fixture()
        output, destination = self.work / 'rpms', self.work / 'dist'
        rpm.build(self.root, '2.github.42', output)
        with contextlib.redirect_stdout(io.StringIO()):
            rpm.verify(self.root, output, platform.machine(), '2.github.42', destination, 'a' * 40)
        expected = 'Deepseek.Harness.Desktop_0.31.0-beta.3+build.9_2.github.42_' + platform.machine() + '.rpm'
        data = json.loads((destination / ('BUILD-rpm-' + platform.machine() + '.json')).read_text())
        self.assertEqual(data['source_sha'], 'a' * 40)
        self.assertEqual(data['version'], '0.31.0~beta.3')
        self.assertEqual(data['filename'], expected)
        self.assertEqual(data['elf_files_checked'], 2)
        digest = hashlib.sha256((destination / expected).read_bytes()).hexdigest()
        self.assertEqual(data['sha256'], digest)
        self.assertEqual((destination / ('SHA256SUMS-rpm-' + platform.machine())).read_text(), digest + '  ' + expected + '\n')
        wrong_arch = 'aarch64' if platform.machine() == 'x86_64' else 'x86_64'
        with self.assertRaisesRegex(ValueError, 'RPM_IDENTITY_INVALID'):
            rpm.verify(self.root, output, wrong_arch, '2.github.42', self.work / 'rejected', 'a' * 40)
        self.assertFalse((self.work / 'rejected').exists())
        artifact = next(output.rglob('*.rpm'))
        shutil.copy2(artifact, artifact.with_name('duplicate.rpm'))
        with self.assertRaisesRegex(ValueError, 'RPM_OUTPUT_INVALID'):
            rpm.verify(self.root, output, platform.machine(), '2.github.42', self.work / 'duplicate', 'a' * 40)


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PackagingTest)
    tests = list(suite)
    random.Random(42).shuffle(tests)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(tests))
    raise SystemExit(not result.wasSuccessful())
