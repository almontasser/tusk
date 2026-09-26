# Tusk's icon

- `icon.svg`: the app icon, an ivory tusk on an indigo tile in the size and corner radius of Apple's icon grid.

To change the icon, edit `icon.svg`, render it to `icon.png` at 1024 × 1024 with a transparent background, then run
`pnpm tauri icon design/icon.png` to make the app's icon files in `src-tauri/icons/`. Chrome renders the SVG
faithfully, including its gradients and shadows:

```sh
cd design
printf '<body style="margin:0;background:transparent"><img src="icon.svg" width="1024" height="1024">' > render.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --default-background-color=00000000 --window-size=1024,1024 --screenshot="$PWD/icon.png" "file://$PWD/render.html"
rm render.html
```
