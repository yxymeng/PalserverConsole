# Third-party notices

本文件用于记录第三方代码、资料和资产的来源与许可证；项目自有内容的许可证见根目录 [`LICENSE`](LICENSE)。

## Windows portable package

`scripts/build-portable.ps1` generates `THIRD_PARTY_LICENSES.md` from the exact
Python runtime/build locks and the npm production dependency graph, then
includes it in each portable package. That generated file covers the bundled
CPython runtime, Python distributions, and frontend runtime packages such as
React and lucide-react. This file retains Palworld-specific attribution and the
explicit non-bundling status of `libooz.dll`.

## palworld-save-tools 0.24.0

- Source: https://github.com/cheahjs/palworld-save-tools
- Purpose in this project: read-only parsing of Palworld `.sav` files during M0.
- License: MIT License
- Copyright: Copyright (c) 2024 Jun Siang Cheah

The following MIT License notice is retained for this dependency:

```text
MIT License

Copyright (c) 2024 Jun Siang Cheah

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

## libooz dynamic local runtime (not bundled)

For a current `PlM` (Oodle-compressed) save, the M0 adapter can load an
explicitly supplied, already-installed `libooz.dll` for read-only decoding. No
DLL is copied into this repository, packaged, or redistributed. The local DLL
used for M0 validation carried this notice:

```text
libooz.dll is distributed with PalCalc under the PalCalc MIT license.

Copyright 2024, Tyler Camp

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

Source links named by that notice: https://github.com/tylercamp/palcalc and
https://github.com/zao/ooz.

## oMaN-Rod/palworld-save-tools compatibility layouts

- Source: https://github.com/oMaN-Rod/palworld-save-tools
- Purpose: M5 read-only compatibility for the 2026-07 character, container,
  base camp, worker-director and guild RawData layouts.
- License: MIT License.
- Scope: only the required binary field layouts were adapted into
  `backend/palserver_console/world/compat.py`; the fork is not bundled and no
  save-writing behavior is used.

The MIT permission and warranty notice shown above for palworld-save-tools also
applies to these adapted layout definitions.

## deafdudecomputers/PalworldSaveTools bundled selected game assets

- Source: https://github.com/deafdudecomputers/PalworldSaveTools
- Fixed revision: `18b9554168ecf684c5f1e1e4d8e583083b942eb9`.
- Purpose: character catalog, selected local WebP portrait source, and the species
  `max_full_stomach`, rarity, work-suitability, and partner-skill source values used
  by read-only world views.
- License reported by the source repository: MIT License.
- Import behavior: `scripts/sync-pal-catalog.ps1` checks out the fixed revision,
  copies only the required WebP files, and retains the source license at
  `frontend/public/assets/pals/LICENSE-PalworldSaveTools.txt`.
- `backend/tools/generate_pal_care_species.py` verifies the pinned
  `characters.json` SHA-256 and generates only the offline Character ID to
  `max_full_stomach` mapping in `world/pal_care_species.py`.
- `backend/tools/generate_world_metadata.py` verifies the same pinned
  `characters.json` SHA-256
  (`83373a0e6dab7f3feac88a08928356b955e07804e0da94b2d452e641ab2609f2`) and
  `skills.json` SHA-256
  (`b9172f389bf56a307194d25b70aca23f8610ef81de32bb44bda827f65b83add1`). It
  generates data version `2026.08.25.3` of the shared offline metadata bundle,
  including 753 Pal records, 2,280 skill records, and 2,466 item records. The bundle records schema
  version 1, fixed source revisions and input hashes, generation method,
  per-collection counts, and a SHA-256 integrity value. Fields unavailable from
  the fixed sources remain explicitly unavailable.
- Application runtime loads only this bundled local metadata. It does not fetch
  metadata from the network or send save contents to this or any other source.

We thank the PalworldSaveTools maintainers for making this catalog available.

## zaigie/palworld-server-tool Chinese Pal and passive-skill mapping

- Source: https://github.com/zaigie/palworld-server-tool
- Fixed revision: `f45a48ef25ce08a5311a27e55b17062ba0bb4362`.
- Purpose: Simplified Chinese labels for Pal and captured human/NPC Character IDs,
  plus passive-skill names and descriptions from `web/src/assets/skill.json`.
- License: Apache License 2.0.
- The source license is retained at
  `frontend/public/assets/pals/LICENSE-palworld-server-tool.txt`.
- `backend/tools/generate_world_metadata.py` verifies the fixed `skill.json`
  SHA-256 (`88f80d0349de940cebed4225da327c8d3ad5e7aa43e502dbd025d64c9489f1c9`)
  before adding it to the local, offline metadata bundle.

We thank the palworld-server-tool maintainers for maintaining the localization mapping.

## Palworld official FModel metadata exports

- Source: locally exported Palworld game resources read with FModel; the export
  files themselves are development inputs and are not bundled in the application.
- Fixed export fingerprints:
  - zh-Hans skill names and descriptions: revision
    `9c8c9eeb8b10bd144ed4ac3aa47b427df72661b7`;
  - item data, common item data, and zh-Hans item names: revision
    `630da112426c0600edb3204b76e13528d336455f`.
- Purpose: offline Simplified Chinese skill text and offline item name, category,
  and rarity metadata for the read-only world views.
- Generated scope: the pinned `2026.08.25.3` bundle contains 753 Pal records,
  2,280 skill records, and 2,466 item records. Missing localized fields remain
  unavailable and are not inferred.
- Rights: these exports are Palworld game content, not MIT or Apache-licensed
  project code. Palworld game data, names, and text remain owned by Pocketpair,
  Inc. and the relevant rights holders. This project is not affiliated with or
  endorsed by Pocketpair.
- Runtime behavior: the application reads only the generated local bundle. It
  does not invoke FModel, fetch game metadata, or upload save contents at runtime.

## shadcn/ui registry components

- Source: https://github.com/shadcn-ui/ui and the shadcn/ui registry.
- Purpose: UI registry component source and scaffolding for the React frontend.
- License: MIT License.
- Copyright: Copyright (c) 2023 shadcn.
- Scope in this project: `frontend/src/components/ui/`,
  `frontend/src/hooks/use-mobile.ts`, `frontend/src/lib/utils.ts`, and the
  related `frontend/components.json` registry configuration.

The components were generated or adapted from the shadcn/ui `base-nova`
registry style and then integrated with this project's tokens and
`@base-ui/react` dependencies. The copied/adapted source remains subject to
the following upstream notice:

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

The other frontend dependencies used by these components retain their own
licenses and are collected separately for Windows portable packages.

## Project-generated brand assets

The Zoe-themed project brand illustration and icon files, including
`frontend/public/zoe-character.png`, `frontend/public/zoe-console-icon.png`,
their derived favicon files, and `branding/PalServerConsole.ico`, were
generated by the project team with OpenAI GPT Image 2. They were not copied or
extracted directly from Palworld, Pocketpair's website, or a third-party asset
library. Favicon and ICO files may be derived from these project-generated
assets. Palworld, Zoe, the characters, names, images, and related intellectual
property remain owned by Pocketpair, Inc. and the relevant rights holders.
This project is not affiliated with or endorsed by Pocketpair.

Palworld names, images and game data may have rights separate from the source
code licenses. Palworld and its character names and images belong to Pocketpair,
Inc. and the relevant rights holders. This project is not affiliated with Pocketpair.
