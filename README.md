# shadcn/ui monorepo template

This is a Next.js monorepo template with shadcn/ui.

## Adding components

To add components to your app, run the following command at the root of your `web` app:

```bash
pnpm dlx shadcn@latest add button -c apps/web
```

This will place the ui components in the `packages/ui/src/components` directory.

## Using components

To use the components in your app, import them from the `ui` package.

```tsx
import { Button } from "@workspace/ui/components/button";
```

## Client-side conversion (no Vercel compute)

No extension-store publisher account is needed.

1. Install Tampermonkey in your browser.
2. Open the raw script URL and install it:

```text
https://raw.githubusercontent.com/1qh/book2pdf/main/tools/hmu-book2pdf.user.js
```

3. Open any `FullBookReader.aspx` page on `thuvien.hmu.edu.vn`.
4. Click `Batch to ZIP` in the bottom-right corner.
5. Paste one reader URL per line, then convert.

The conversion runs entirely on the user device and downloads one ZIP of PDFs.
