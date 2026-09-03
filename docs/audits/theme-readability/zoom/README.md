# Focused comparison crops

These crops keep the original pixels from the deterministic 1600x1200 audit screenshots. They isolate the small secondary text affected by the shared theme-token change.

| Surface | Crop | Before source | After source |
|---|---|---|---|
| Light inbox metadata | `1120x330+120+140` | audit baseline `400d9e6` | theme fix `83b0dc5` |
| Light diff controls | `1260x390+300+350` | audit baseline `400d9e6` | theme fix `83b0dc5` |
| Dark agent settings | `1250x460+220+120` | audit baseline `400d9e6` | theme fix `83b0dc5` |

ImageMagick command shape:

```sh
magick SOURCE.png -crop WIDTHxHEIGHT+X+Y +repage OUTPUT.png
```
