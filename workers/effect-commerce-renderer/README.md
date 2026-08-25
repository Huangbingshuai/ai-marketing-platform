# Effect Commerce Renderer

独立的 Playwright Chromium 渲染服务，仅供 AI 信息提炼 Worker 读取公开商品页。服务不会携带登录态，不支持验证码或风控绕过。

## 接口

### `GET /health`

无需鉴权，成功返回：

```json
{ "status": "ok" }
```

### `POST /render`

请求必须携带 `Authorization: Bearer <token>`：

```json
{ "url": "https://shop.example.com/product/123" }
```

成功响应：

```json
{
  "html": "<html>...</html>",
  "finalUrl": "https://shop.example.com/product/123",
  "host": "shop.example.com",
  "title": "商品名称"
}
```

错误响应只包含稳定错误码和安全中文文案，不回显 URL。主要错误码为 `UNSAFE_TARGET`、`RENDER_TIMEOUT`、`DOM_TOO_LARGE`、`UNSUPPORTED_CONTENT` 和 `RENDER_FAILED`。

## 环境变量

| 变量                                    | 必填 | 默认值    | 说明                                      |
| --------------------------------------- | ---- | --------- | ----------------------------------------- |
| `COMMERCE_RENDERER_TOKEN`               | 是   | 无        | Worker 与渲染服务共享 Token，至少 16 字符 |
| `COMMERCE_RENDERER_HOST`                | 否   | `0.0.0.0` | 监听地址                                  |
| `COMMERCE_RENDERER_PORT`                | 否   | `8080`    | 监听端口                                  |
| `COMMERCE_RENDERER_MAX_CONCURRENCY`     | 否   | `2`       | 最大并发页面数                            |
| `COMMERCE_RENDERER_TIMEOUT_SECONDS`     | 否   | `25`      | 包含排队的单请求总超时                    |
| `COMMERCE_RENDERER_MAX_DOM_BYTES`       | 否   | `2097152` | UTF-8 DOM 上限                            |
| `COMMERCE_RENDERER_SETTLE_MILLISECONDS` | 否   | `750`     | DOMContentLoaded 后等待动态内容的时间     |

## 安全边界

- 仅允许 HTTP/HTTPS 和 80/443 端口。
- 主页面、重定向最终页面和所有可拦截子请求均执行 DNS 公网地址校验。
- 拒绝私网、回环、链路本地、保留地址和云元数据地址。
- 每次请求使用新的无 Cookie Browser Context，禁用 Service Worker 和下载。
- 图片、视频和字体在发起前被拦截；WebSocket 连接全部禁用。
- 应用校验不能替代生产环境的网络出口策略；部署时仍应在容器网络层阻断私网和云元数据地址。

## 本地验证

```powershell
uv sync --frozen
uv run --frozen pytest
uv run --frozen mypy src tests
```

安装本机 Chromium 后可手动运行：

```powershell
uv run playwright install chromium
$env:COMMERCE_RENDERER_TOKEN="replace-with-a-local-secret"
uv run effect-commerce-renderer
```
