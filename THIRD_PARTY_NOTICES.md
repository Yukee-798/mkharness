# Third-party notices

The components in `src/browser/ui/` are copied or adapted from the official [shadcn/ui](https://github.com/shadcn-ui/ui) registry under MIT (Copyright (c) 2023 shadcn). The utilities remain local. `components.json` records the registry configuration for adding further components. Its license notice follows.

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`src/browser/markdown-text.tsx`, `tooltip-icon-button.tsx`, `hooks/use-copy-to-clipboard.ts`, `reasoning.tsx`, `model-selector.tsx`, `model-selection.ts` and the read-only display subset in `tool-fallback.tsx` are copied or adapted from the official [assistant-ui registry](https://www.assistant-ui.com/elements/thread), under MIT (Copyright (c) 2026 AgentbaseAI Inc.). The Markdown copy label is translated; the tool fallback and streaming reasoning disclosure use shadcn Collapsible and Chinese labels, and omit approval controls. The model selector uses its standalone API with shadcn Command/Popover, Chinese labels and application-owned HTTP submission. The MIT permission and warranty text above also applies to these files, with this copyright holder.

Runtime dependencies are installed by pnpm; their own licenses remain in the package distributions. React, assistant-ui, AG-UI, OpenUI, Cloudflare Agents, Pi AI/Pi Durable, QuickJS Emscripten, Better Auth, Hono, Tailwind CSS and Radix are used through their public interfaces. QuickJS upstream uses MIT; `class-variance-authority` uses Apache-2.0. Keep these upstream notices when redistributing bundled assets.

Research documents retain links and attribution to their source projects. No reference application code or generated business algorithm is registered as a production tool in this template.
