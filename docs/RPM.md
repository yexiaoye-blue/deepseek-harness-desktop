# GitHub RPM 构建

RPM 工作流构建所选提交中的源码和固定版本的子模块，输出 x86_64、aarch64 两种架构，适用于 Fedora 43 及以上版本。与独立的上游版本跟踪打包仓库不同，这里会包含当前 Fork 的修改。

## 构建与发布

- 工作流合入默认分支后，在 Actions 中运行 **Build RPM**，选择源码分支；构建结果保存在 `release-rpm-x86_64`、`release-rpm-aarch64` 两个产物中。
- `main` 或 `feature/**` 分支中的 RPM 工作流、打包脚本或模板变动也会触发构建。
- 发布 `v*` 标签或合并 `release/*` PR 时，现有发布流程会一起构建 RPM，验证成功后上传到当前仓库的 Releases。
- 手动运行 **Build & Release** 并选择 `linux-rpm`，只构建 RPM 并发布测试预发布版本；选择 `linux` 会同时生成 AppImage、DEB 和 RPM。RPM 单独构建不需要 macOS 或 Windows 的签名密钥。

构建固定使用 Ubuntu 22.04，检查全部 ELF 的架构与 GLIBC 需求（不高于 2.35），随后在 Fedora 43 容器中验证安装、主程序动态库依赖和 Electron 沙箱权限。容器检查不验证桌面窗口与宠物的实际显示效果。

每个架构的产物还包括 `SHA256SUMS-rpm-<架构>` 和 `BUILD-rpm-<架构>.json`，记录源码 SHA、版本、架构、校验和与 ABI 检查结果。

## 安装与升级

下载适合本机架构的 RPM 后安装：

```bash
sudo dnf install ./Deepseek.Harness.Desktop_*.rpm
```

包名为 `dsh-tauri`，包含 Electron 运行时、桌面入口、图标和上游许可文件。RPM 构建关闭应用内自动更新，后续升级需要安装新 RPM。

应用版本保留源码中的 SemVer；RPM 元数据将预发布分隔符转换为 `~`，确保正式版高于同版本的预发布版。构建号使用 `2.github.<GitHub run ID>`，同一版本重新运行工作流时应选择 **Run workflow** 创建新运行；直接重跑旧运行会保留原构建号。

## 本地验证

Linux 环境需要 Python 3、Node.js、C 编译器、`rpmbuild`、`rpm`、`readelf` 和 `bsdtar`：

```bash
python3 -B scripts/test_rpm_packaging.py
```

测试使用临时目录中的小型 ELF 生成并检查真实 RPM，不安装软件，也不访问用户的应用配置。
