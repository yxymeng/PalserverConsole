# Third-party notices

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
- Purpose: character catalog and selected local WebP portrait source for the read-only world browser.
- License reported by the source repository: MIT License.
- Import behavior: `scripts/sync-pal-catalog.ps1` checks out the fixed revision,
  copies only the required WebP files, and retains the source license at
  `frontend/public/assets/pals/LICENSE-PalworldSaveTools.txt`.

We thank the PalworldSaveTools maintainers for making this catalog available.

## zaigie/palworld-server-tool Chinese character mapping

- Source: https://github.com/zaigie/palworld-server-tool
- Fixed revision: `f45a48ef25ce08a5311a27e55b17062ba0bb4362`.
- Purpose: Simplified Chinese labels for Pal and captured human/NPC Character IDs.
- License: Apache License 2.0.
- The source license is retained at
  `frontend/public/assets/pals/LICENSE-palworld-server-tool.txt`.

We thank the palworld-server-tool maintainers for maintaining the localization mapping.

Palworld names, images and game data may have rights separate from the source
code licenses. Palworld and its character names and images belong to Pocketpair,
Inc. and the relevant rights holders. This project is not affiliated with Pocketpair.
