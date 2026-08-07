#!/usr/bin/env bash
# Downloads the source 3D models from the shared Google Drive folder into raw/.
# raw/ is gitignored - only the processed output in assets/ is committed.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p raw
dl() { # dl <drive-id> <filename>
  if [ -s "raw/$2" ]; then echo "have $2"; return; fi
  echo "fetching $2"
  # This endpoint works for every file in the folder, including the zip, which
  # 404s on drive.usercontent.google.com.
  curl -sL --max-time 600 "https://drive.google.com/uc?export=download&id=$1" -o "raw/$2"
}

dl 1gOwQYNtje9KZU2ZnwI4wt64uWw4pXwfb lightning_mcqueen.glb
dl 1JmiZHYJhoOHX8LT7wqxC4a3Y5fpe9Wi1 chick_hicks.glb
dl 1Pce8C7ThGC_GVZ862lwZ8PA3bqymhnYi the_king.glb
dl 189IRUhEfCWrb36jJq6KB7agY0WFRvR_i francesco_bernoulli.glb
dl 1_deQFaSSXjsE0XpQZeWj2O7JlIZshsQF jackson_storm.glb
dl 1IJE3vNou8K6JqshdZVLscvhYFMHU9Vtt mater.glb
dl 1z4iN5vIWUhcE7erlPGlgp1zsh8NaVrN- doc_hudson.zip
# Pit crew and paddock scenery, not racers - see "racer": false in cars.json.
dl 1hlJxOhn0fqldAlxlrPElEJOUplPfUZY5 guido.glb
dl 1ccKUss0KPzDvUIXIAWElo0ecXJKIlR4u mack.glb
# The rest of the field. Added when the owner asked for every car on the grid.
dl 156o5CdQEfnirwLCmzCVlWDo3jpjurH93 carla_veloso.glb
dl 1OPYUlDK5ltxG3Y-Aga55S34wEObnRtP5 claude_scruggs.glb
dl 1dtxpc2Jtj5RrGrwPGDQJfKILRuImNR_l cruz_ramirez.glb
dl 1nQzOuBMggsb6FypZcWYksoNZ6LCAIs2e darrel_cartrip.glb
dl 1ZpYisYy0OFLKLtvSuJX-C7-EwEl1jzKJ fillmore.glb
dl 1-ZMsj4keFumNwk7e572eFqSf6TfBCo0E finn_mcmissle.glb
dl 1309XIDVpatuG_iHdCNMwIRLs_-XkCTOI ivy.glb
dl 1zqA56hnkvBSBcsWpS2JUf1lKaCNmbZrH michael_schumacher_ferrari.glb
dl 1Oc_ONv6xX5v9vijWR7-YpOENwJa0XsCW sally_carrera.glb
dl 1VjE9Xn_4To-eBEYEWNPhuzRIDwxzzN4Q sarge.glb
dl 1nYMiRaqnr4pT2YH5v0blE4o6OYmEhnic shu_todoroki.glb
dl 19aGhX9W7IiqlQ49xtTzVTBJ_qmjTMT6A speedway.glb
dl 1LjtNoYQuki08Cjl-4lzOaMB_TvDDgUGo motor_speedway_of_the_south.glb
dl 1Afjldi0myxASoDico8WBZYHkffamog6J palm_mile_speedway.glb

if [ ! -s raw/doc_hudson.glb ]; then
  python3 -c "
import zipfile
z = zipfile.ZipFile('raw/doc_hudson.zip')
open('raw/doc_hudson.glb','wb').write(z.read('source/doc_hudson.glb'))
"
  echo "extracted doc_hudson.glb"
fi

ls -la raw/*.glb
