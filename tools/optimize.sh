#!/usr/bin/env bash
# Compress the raw Sketchfab models down to something a phone can download.
#
# IMPORTANT: the speedway must be baked into world space before anything
# quantises it. Sketchfab stored its geometry in a local space spanning about
# +/-3,000,000 units, scaled down to ~660 m by the node hierarchy. Point a
# quantising compressor at that and it lays a 14-bit grid over millions of
# units: the banked asphalt collapses onto the flat apron, the infield grass
# ends up on top of the racing surface, and the cars float a metre in the air.
# tools/bake_transforms.py bakes the transforms so local coordinates are
# metres, after which quantisation behaves and 16-bit positions hold the deck
# to about a centimetre.
#
# Verify with tools/verify_track.mjs after any change here - it raycasts the
# shipped asset and checks the surface still matches assets/track-data.json.
#
# Cars are only a few thousand triangles each and are seen up close, so they
# are compressed but never simplified. McQueen is a skinned mesh; simplifying
# it would wreck the skin weights.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$PATH"
GT="./tools/node/node_modules/.bin/gltf-transform"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p assets/cars

# track <source> <output> <simplify-ratio> <simplify-error>
# The error is a fraction of the mesh radius, so it has to be scaled to the
# model: Yoyleland is ~800 m across, the other two are modelled at about 1:15.
track() {
  python3 tools/bake_transforms.py "raw/$1.glb" "$TMP/baked.glb" | sed 's/^/  /'
  $GT weld "$TMP/baked.glb" "$TMP/w.glb" > /dev/null
  $GT simplify "$TMP/w.glb" "$TMP/s.glb" --ratio "$3" --error "$4" > /dev/null
  $GT webp "$TMP/s.glb" "$TMP/sw.glb" > /dev/null
  $GT meshopt "$TMP/sw.glb" "assets/$2" --quantize-position 16 > /dev/null
  printf '  %-22s %s\n' "$2" "$(du -h "assets/$2" | cut -f1)"
}

echo "=== tracks ==="
track speedway                    track.glb        0.35 0.00007
track motor_speedway_of_the_south track-msots.glb  0.60 0.00006
track palm_mile_speedway          track-palm.glb   0.60 0.00006

# Cars are nearly all texture weight - 1024px maps on a car that is a few
# hundred pixels tall on a phone. 512 + WebP is visually identical here.
echo "=== cars ==="
for car in lightning_mcqueen chick_hicks the_king francesco_bernoulli jackson_storm mater doc_hudson \
           guido mack; do
  $GT dedup "raw/$car.glb" "$TMP/d.glb" > /dev/null
  $GT resize "$TMP/d.glb" "$TMP/r.glb" --width 512 --height 512 > /dev/null
  $GT webp "$TMP/r.glb" "$TMP/p.glb" > /dev/null
  $GT meshopt "$TMP/p.glb" "assets/cars/$car.glb" > /dev/null
  printf '  %-22s %s\n' "$car" "$(du -h "assets/cars/$car.glb" | cut -f1)"
done

echo
du -ch assets/track.glb assets/cars/*.glb assets/track-data.json | tail -1
