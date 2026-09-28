# Jeff 的 WebDAV 迁到 ECS

2026-09-26。把 Jeff 的 WebDAV 从 sealos 迁到阿里云 ECS `i-wz9dvof54j66ouau9zri`（公网 `47.106.209.32`）。Jeff 应用代码没有改，没有升版本，也没有打安装包。

## 服务器

机器是 Ubuntu 26.04.1 LTS，几乎空闲。加了 1 GiB swap（`/swapfile`，已写入 `/etc/fstab`）。用 Ubuntu 源安装了 Docker 29.1.3 和 Compose 2.40.3。

`/opt/webdav` 里用 Compose 跑 `ghcr.io/hacdias/webdav:v5.16.0`。镜像默认听 6065，宿主机只把 443 映射进去（`443:6065`）。证书是自签的，SAN 为 `IP:47.106.209.32`，有效期到 2036-09-22。配置和私钥权限是 `600`。容器 `restart: unless-stopped`。跑起来后进程大约 18 MiB。

账号是新的，没有复用 sealos 的密码。密码只在服务器 `/opt/webdav/cred.txt`、`config.yml`，以及本机 Jeff 的 `settings:webdav` 里。

上线前用临时路径 `/jeff-probe-tmp/` 验证了 MKCOL、PUT、GET、PROPFIND、DELETE，错误密码返回 401。测完已删除，数据目录里只剩 `jeff/`。

## 数据

从 `https://swkoalbjimkk.sealosbja.site` 只读拷贝了 `/jeff`。按目录逐级列出（不用 Depth infinity）。sealos 上有 20 个含 `index.html` 的目录列不出来，这些文件用 `skills-manifest.json` 补全。一共 2055 个文件、约 193.4 MiB。拷完后新服务器能列出全部文件，数量一致，没有多出来的文件。`manifest.json`、`settings.json`、`agents.json`、`projects.json`、`tasks.json`、`tombstones.json`、两份 manifest 的 SHA-256 与源一致。sealos 上没有做删除。

## 本机 Jeff

这台 Linux 的 WebDAV 已改为：

- URL：`https://47.106.209.32`
- 用户名：`jeff`
- 基目录：`/jeff`
- 校验证书：关
- 自动同步：开

随后跑了一轮真实同步。返回的报告是成功：上传 16、下载 86。两端都改过、按更新时间取较新一侧的记录有 10 条：`settings`、用户记忆、4 条智能体记忆、1 条项目记忆、用户 AGENTS.md、2 条项目 AGENTS.md。远端 `manifest.json` 的 `updatedAt` 从 `1790357769794` 变成 `1790358576246`。

同步成功后，应用按现有逻辑自动做了目录镜像：

- skills：上传 5、跳过 643、归档后删除 60（本地 `~/.agents/skills` 里没有的远端文件）。归档在新服务器的 `/jeff/skills-versions/`。
- 插件：上传 1、跳过 1，没有删除。

这 60 个文件在旧 sealos 上还在。其他机器改完地址后再做 skills 备份时，如果本地仍有这些文件，会再传上去。

## 其他 Jeff

Windows 和其他还在同步的机器，在改设置之前仍会写旧 sealos。要填的是同一组地址、用户名、基目录，并关掉校验证书，然后点一次同步。密码不写在这里，向操作者当面交付。

回退：把 URL 改回 `https://swkoalbjimkk.sealosbja.site`，用户名改回原来的 `webdav`，重新打开证书校验，基目录仍是 `/jeff`。旧密码已经不在 Jeff 数据库里，留在本机 `.tmp/sealos-cred.json`（已 gitignore，不进仓库）。

## 思源笔记

思源把 WebDAV 地址当成已有的根目录，锁云端时是在其下上传 `lock-sync`，不会自己创建这个根。地址 `https://47.106.209.32/siyuan/` 对应的集合原先不存在，子目录 `MKCOL` 返回 409，界面就显示「锁定云端同步目录失败」。已创建 `/siyuan/`。思源自己会再在下面建 `<云端同步目录名>/siyuan/repo/`。

第一次同步中断后，云端只剩下 `main/siyuan/repo/objects` 下 21 个对象，没有 `refs` 和 `indexes`。思源据此报「云端数据已经损坏」。清掉 `main` 后再次同步，从 02:14 传到 02:19，又只落下 83 个对象，仍然没有索引。按思源《同步指南》问题 2，这种半成品不能继续用，需要换一个新的云端目录名，并且不要重置数据仓库密钥。WebDAV 在思源界面里不能删除云端目录，服务器上已再次删掉 `main`，`/siyuan/` 仍在。
