# Bybit USD Telegram bot

将本目录的内容作为 GitHub 仓库根目录上传，必须包含 `.github/workflows/build.yml` 等隐藏文件。不要上传真实 `.env`、`data/` 或 `id.txt`；网页上传也需要手动排除这些文件。

推送代码后，Actions 自动构建 Linux amd64 镜像。默认分支构建成功后发布到 `ghcr.io/<用户名>/<仓库名>:latest`（名称全小写），同时发布 `sha-<完整提交 SHA>` 标签。其他分支和 PR 只构建。也可在 Actions 页面手动运行。使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需把交易密钥放进 GitHub Secrets。

Docker 构建只检查 JavaScript 语法和依赖加载，不启动机器人。基础镜像使用 Node.js 24；直接依赖固定版本，传递依赖尚未使用 lockfile 锁定。`requirements.txt` 不用于此 Node.js 项目。

## 在服务器运行

准备 Docker Compose、`run.yml`、`.env.example` 和 `id.txt.example`，在这些文件所在目录执行：

```sh
cp .env.example .env
mkdir -p data
cp id.txt.example data/id.txt
```

编辑 `.env`：将 `GHCR_IMAGE` 改为实际镜像地址（不加 `:latest`），填写 Bybit **测试网** API key/secret 和 Telegram BOT_TOKEN。将 `data/id.txt` 中示例 ID 全部替换成自己的 Telegram 用户 ID，每行一个。

Linux 服务器上，容器以 UID 1000 运行，需要读写 data：

```sh
sudo chown -R 1000:1000 data
chmod 700 data
chmod 600 .env data/id.txt
```

GHCR 包若为私有，先使用有 `read:packages` 权限的 GitHub PAT 登录（在密码提示中输入令牌），或在 GitHub Packages 设置中将镜像设为 public：

```sh
docker login ghcr.io -u YOUR_GITHUB_USERNAME
docker compose -f run.yml up -d
docker compose -f run.yml logs -f --tail=100
```

更新镜像：`docker compose -f run.yml pull`，然后 `docker compose -f run.yml up -d`。

停止：`docker compose -f run.yml down`。消息进度保存在 `data/telegram-offset.json`，更新和重建容器时应保留 data 目录。每个 BOT_TOKEN 只运行一个实例，且不能同时配置 Telegram webhook。当前脚本固定连接 Bybit 测试网，接收 `/buy`、`/sell` 后提交 USDTUSD 的 1 USDT 市价单。

如需将本目录保留在大仓库的子目录中，需要把 workflow 放到仓库根目录的 `.github/workflows/`，并修改构建步骤的 `context` 为本目录相对路径。
