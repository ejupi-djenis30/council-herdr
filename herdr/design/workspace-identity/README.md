# Council identity and Workspace

## Official interface icons

Council vendors 18 standalone monochrome SVGs from [Ejupi Labs Icons 1.3.1](https://github.com/Ejupi-Labs/ejupilabs-icons/tree/c37702fc04da7a114e5eea4416d621bd7723c74d/mono). Each `ejupi-<name>.svg` is a byte-for-byte copy of `mono/<name>.svg` at that revision. The [MIT notice](../../mods/council/icons/LICENSE.ejupilabs-icons.txt) ships in the managed install and npm package.

| Surface | Official icons |
| --- | --- |
| Council sections and menu | Grid, list, pipeline, calendar, message, shield-check, users |
| Workspace context and actions | Folder, file-text, code, terminal, copy, search, plus, warning, file |
| Run states | Warning, clock, check |

Herdr draws these SVGs through gpui-kit and applies the surrounding theme text colour. Primary icons and titles use the foreground token. Status filters pair a labelled state with its glyph and count. Workspace badge text uses the foreground token while the dot keeps its semantic colour. The bundled SVGs resolve from the Herdr app home. [Herdr mod guide](https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md)

## Original Council mark

The launcher and Council window use the [round-table SVG](../../mods/council/icons/brand.svg). The [ImageGen source](council-imagegen.png) is the original output of Codex's integrated ImageGen tool. The SVG redraw uses the generated image's open ring and three inward-facing seats. The redraw centres the ring, aligns the mirrored seats and opens up the gaps for the 25 px launcher tile. Pear on Night keeps the silhouette legible in both appearances.

**Source PNG SHA-256** `fccd07ca4a4342a898105e244387d9bbf7ecb3bfa9c918de28e8c4b1fe46c1fc`

<details>
<summary>Exact ImageGen prompt</summary>

> Generate ONE original flat geometric product emblem for Council, a native desktop module where agents deliberate and hand off work. Square canvas, transparent outside the emblem. Show an overhead round table as a broad solid chalk-white ring with an open circular center, surrounded by exactly three separate compact pear-green rounded trapezoid seats, one centered above the ring and two symmetrically facing it from the lower diagonals. The three seats point inward but never touch the table or each other. The arrangement should fit comfortably within a centered 80% safe area. A bold, calm silhouette, friendly geometry, large cutouts and broad clean gaps that remain distinct when rendered at 24 px. Solid flat fills, precisely aligned, front-on with no perspective, no outline, no text, no border, no app tile, no shadows, no gradients, no grain, no mockup. This transparent PNG is the visual reference for a hand-refined SVG mark.

Tool parameter `transparent_background = true`. The prompt asked for two inks. The installed mark uses a single tint supplied by gpui-kit.

</details>

## Native previews

The cropped `herdr-app shot` captures come from Herdr Desktop 0.1.16 on Windows ARM64 with a simulated Git project. Runs used the installed Council window and its normal data path. The Plan, Changes and menu captures used temporary native proof overlays with the shipped renderers and explicit fixture state. The proof overlays and sample records stay outside the mod package.

| Capture | What it shows |
| --- | --- |
| [Before](before-runs-dark.png) | The baseline at `a344a2f`, with the same runs and decisions |
| [Runs · Graphite](runs-dark.png) | Sidebar mark, section icons, run filters, three run states and decision desk |
| [Runs · Paper](runs-light.png) | The same live view in the light appearance |
| [Plan · Paper · narrow](plan-narrow-light.png) | The dependency map and selected component stacked in a 580 px overlay |
| [Changes · Paper](changes-light.png) | A corrupted fixture record in Read issues, with the Git paths still visible |
| [Council menu · Graphite](menu-dark.png) | The seven destinations and their labelled icons |

Measured foreground contrast in the captured themes includes 11.7:1 and 14.7:1 for the selected section icon, and at least 4.9:1 for the sampled muted icon on its card. The weakest sampled status dot was 4.3:1 on its light badge. The mark's Pear and Night pair is 16.0:1.

Native load and render checks passed. The new controls use gpui-kit buttons, accessible names, visible focus styles and announced selection where supported. The captures confirm appearance and the supplied states. Keyboard activation and screen-reader output were not exercised end to end. The workspace fixture used saved sample records without launching agents.
