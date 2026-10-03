# Example plugins

Each folder is a complete Pi Desktop plugin. To try one, open **Settings → Desktop plugins → Load a plugin under development** and choose its folder; Pi Desktop loads it from there and reloads it whenever you save a file.

| Folder                       | Shows                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`todo-finder`](todo-finder) | A panel, a ⌘K command and an agent tool sharing one scanner in the plugin process; the panel talks to the process through `onPanelInvoke`. |
| [`sepia-theme`](sepia-theme) | A theme: a stylesheet of design tokens.                                                                                                    |

The code is plain JavaScript checked against [`resources/plugin-sdk/pi-desktop.d.ts`](../../resources/plugin-sdk/pi-desktop.d.ts) through `jsconfig.json`, so editors complete the `pi` API with no build step. A plugin made with **New plugin** gets its own copy of the types in `types/`.

See [PLUGINS.md](../../PLUGINS.md) for the manifest, permissions and API, and §22 for the development workflow.
