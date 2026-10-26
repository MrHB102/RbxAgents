# Blender integration

RBX Agents connects agents to Blender through [MCP for Blender](https://github.com/ahujasid/mcp-for-blender) by Siddharth Ahuja (`mcp-for-blender`, MIT). It is a separate project: nothing from it is bundled, and it is not affiliated with Blender or with RBX Agents. This page describes what RBX Agents does with it and what to watch for.

Added in 0.2.1.

## What you get

- A **Blender** connection under **MCP bridges**, with a one-click installer, a **Check Blender** button, and the usual Connect and Configure controls.
- An **Artist** agent wired to it. Any other agent can use Blender too (**Configure → Connections**).
- **Previews in the chat.** `render_preview` renders in your open Blender and posts the result as a playable video, or an image for a still. `share_media` posts an existing image or video from your computer.

## The one-click install

Select **Install Blender add-on**. It runs these steps, in this order, and stops at the first failure:

1. **uv.** If `uvx` is not found, you are asked whether to install it. If you agree, the app runs Astral's official installer (`install.ps1` on Windows, `install.sh` elsewhere), which adds uv to your user PATH and needs no administrator rights. If you decline, nothing is installed.
2. **The add-on.** `uvx mcp-for-blender@2.2.4 install-addon`. The first run downloads the server from PyPI. The installer copies `blender_mcp.py` into the add-ons folder of **the newest Blender it finds** (for example `%APPDATA%\Blender Foundation\Blender\5.2\scripts\addons`).
3. **Turn it on.** The app finds Blender (standard folders, or the program you chose in the connection settings) and starts a copy with no window to enable the add-on and save your preferences. Only the Blender version the add-on was installed for is changed; others are listed and left alone.
4. **Restart Blender** if it is open. The add-on starts its connection by itself whenever Blender opens.

What is touched: that Blender version's add-ons folder and saved preferences, uv's own folders, and your user PATH if uv was installed. Pressing the button again reinstalls the same pinned version. The server version is pinned in the connection's arguments (`mcp-for-blender@2.2.4`); change it there to try another release, and install again so the add-on matches.

If Blender is not found, the add-on is still installed. The message says so and tells you to turn it on under **Edit → Preferences → Add-ons → MCP for Blender**.

## Connecting

**Connect bridge** starts `uvx mcp-for-blender@2.2.4` as a local process. The server talks to the add-on over a local socket (`localhost:9876` by default). **Check Blender** tries that socket and, when something answers, asks the server for its report (Blender version, whether the add-on matches the server, which asset libraries are available).

To use another port, add `--port 9877` to the connection's arguments and set the same port in Blender's **MCP for Blender** panel (press N in the 3D viewport). The same applies if another Blender MCP add-on already uses 9876.

## Tools and access modes

| Tool | Access |
| --- | --- |
| `get_scene_info`, `look`, `get_addon_status`, `search_assets` | Read: runs in every access mode |
| `execute_blender_code`, `import_asset`, `generate_3d` | Changes Blender: refused when read-only, approval in Ask mode. The approval card shows the Python itself, not a JSON string. |
| `render_preview` | Changes settings temporarily and writes files: same rules as above |
| `share_media` | Only copies a file into the app: runs in every access mode |
| `disable_telemetry`, `record_trajectory_feedback` | Hidden from agents |

The server asks models to repeat the user's prompt in every call for its usage statistics. That field is removed from the schemas agents see, and the connection sets `DISABLE_TELEMETRY=true`. `generate_3d` and `import_asset` can use third-party services and credits configured in the add-on; they always need approval outside Unrestricted mode.

## Previews

`render_preview` arguments:

| Argument | Values | Default |
| --- | --- | --- |
| `mode` | `turntable` (orbits the model once), `animation` (the scene's own animation from its first frame), `still` | `turntable` |
| `frames` | 8 to 240 (length of the turntable, or the most frames of the animation) | 72 |
| `height` | 240 to 1080 pixels, keeping the scene's aspect ratio | 540 |
| `engine` | `eevee`, `workbench`, `scene` (use the scene's own) | `eevee` |
| `format` | `mp4` (H.264), `webm` | `mp4` |
| `focus` | `all` visible objects, or only the `selected` ones | `all` |
| `caption` | up to 300 characters | none |

How it renders: it runs a script inside your open Blender through `execute_blender_code`. The script changes the render settings it needs, adds a temporary camera, pivot, and light only when the scene has none (a turntable always uses its own camera), renders into a private folder, and then puts every setting back and removes what it added. The video or image is copied into the app, checked by content, and shown in the chat; the temporary files are deleted.

Previews are stored under `media/` in the app's data folder, served to the window only by random id, and removed when their conversation is deleted or no message refers to them. Each card has **Save a copy** and **Show in folder**. Limits: MP4, WebM, GIF, PNG, JPEG, and WebP only; videos up to 400 MB, images up to 60 MB. Videos play muted and loop.

## Security notes

- The add-on's socket server has **no authentication or encryption**. It listens on this computer only, but any program running here can reach it while Blender is open, and `execute_blender_code` runs arbitrary Python in your session. Close Blender or turn the add-on off when you are not using it.
- In Ask mode every script is shown to you before it runs. In Unrestricted mode it is not.
- Save your `.blend` before long agent sessions. A script can change or delete scene data.
- The downloaded server and add-on are third-party code that runs as your user. Review the project if that matters to you; the version is pinned so it does not change underneath you.
- `share_media` shows files from your computer in the chat window and keeps a copy in the app's data folder. It sends nothing to a model or the internet. `share_media` needs no approval, so a web page that tricks an agent could make it show an image or video from your computer in the chat. The agent still cannot see or send it, and only the allowed types can be shown.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| "uv is not installed" | Install uv from https://docs.astral.sh/uv/ or allow the app to, then try again. |
| Install fails with a disk error | uv keeps a download cache (`UV_CACHE_DIR`). Point it at a drive with space before starting the app. |
| **Check Blender** says nothing answers | Blender is closed, the add-on is off, or the port differs. Open Blender; check **Edit → Preferences → Add-ons**; press N and open the **MCP for Blender** tab to see the port and the server status. |
| It answers but the report is an error | Another Blender MCP add-on may hold the port. Use a different port in both places. |
| The add-on is enabled but tools fail | Restart Blender after installing; make sure the server and add-on are the same release (**Check Blender** reports a mismatch). |
| A preview never appears | Blender is busy rendering (the call waits up to ten minutes), or the render failed; the chat shows Blender's own error. Previews need Blender on the same computer. |
| Stop was pressed during a render | The agent stops, but Blender finishes the render it already started. |

## What was verified

- Unit and integration tests cover the installer's every branch with stand-in processes, the media store (content checks, ranges, cleanup), the MCP tool filtering, and the full runtime flow against a stand-in Blender server.
- With real Blender 4.5 and 5.2 (opt-in, headless): the preview script renders MP4, WebM, and PNG, frames the whole scene, and leaves render settings, camera, light, world, and frame range exactly as they were. `RBX_BLENDER` takes the program paths.
- With the real server and the real add-on (opt-in, a real Blender window for a few seconds, a throwaway profile): install, enable, connect, scene info, and a rendered turntable posted as a video, on 4.5 and 5.2. `RBX_LIVE_BLENDER` takes the program path. The one-click installer was also run for real against a pretend profile.
- In the Electron app, MP4 and WebM rendered by Blender play in the chat, the PNG loads, nothing overflows the window, and only descriptions (not files) are saved with the conversation.
- Not verified: macOS and Linux, Blender versions other than 4.5 and 5.2, and the interactive uv installer prompt.

```bash
RBX_BLENDER="C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" npx vitest run tests/unit/blender.live
RBX_LIVE_BLENDER="C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" npx vitest run tests/unit/blender-addon.live
```