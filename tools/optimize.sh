#!/usr/bin/env bash
# Compress the raw Sketchfab models down to something a phone can download.
#
# The speedway is 38 MB / 755k triangles as shipped. Welding + simplifying +
# meshopt gets it to ~5 MB / 420k triangles while moving the track deck by less
# than 5 mm at p95, which matters because assets/track-data.json was measured
# off the original mesh and the cars sit on those heights.
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

echo "=== speedway ==="
$GT weld raw/speedway.glb "$TMP/w.glb" > /dev/null
$GT simplify "$TMP/w.glb" "$TMP/s.glb" --ratio 0.4 --error 0.005 > /dev/null
$GT webp "$TMP/s.glb" "$TMP/sw.glb" > /dev/null
$GT meshopt "$TMP/sw.glb" assets/track.glb > /dev/null
printf '  %-22s %s\n' "track" "$(du -h assets/track.glb | cut -f1)"

# Cars are nearly all texture weight - 1024px maps on a car that is a few
# hundred pixels tall on a phone. 512 + WebP is visually identical here.
echo "=== cars ==="
for car in lightning_mcqueen chick_hicks the_king francesco_bernoulli jackson_storm mater doc_hudson; do
  $GT dedup "raw/$car.glb" "$TMP/d.glb" > /dev/null
  $GT resize "$TMP/d.glb" "$TMP/r.glb" --width 512 --height 512 > /dev/null
  $GT webp "$TMP/r.glb" "$TMP/p.glb" > /dev/null
  $GT meshopt "$TMP/p.glb" "assets/cars/$car.glb" > /dev/null
  printf '  %-22s %s\n' "$car" "$(du -h "assets/cars/$car.glb" | cut -f1)"
done

echo
du -ch assets/track.glb assets/cars/*.glb assets/track-data.json | tail -1
