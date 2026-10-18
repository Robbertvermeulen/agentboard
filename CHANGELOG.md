# [0.26.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.25.1...v0.26.0) (2026-10-18)


### Features

* **card:** show the agent's current step instead of a static live line ([#114](https://github.com/Robbertvermeulen/agentboard/issues/114)) ([3c4a108](https://github.com/Robbertvermeulen/agentboard/commit/3c4a1086ef6bb232912c5685a75a7ee2037eed6b))

## [0.25.1](https://github.com/Robbertvermeulen/agentboard/compare/v0.25.0...v0.25.1) (2026-10-16)


### Bug Fixes

* **runner:** pass the prompt after -- so --mcp-config does not swallow it ([#116](https://github.com/Robbertvermeulen/agentboard/issues/116)) ([2035ca2](https://github.com/Robbertvermeulen/agentboard/commit/2035ca257354e868655bb28d444ff6eed657ca61))

# [0.25.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.24.0...v0.25.0) (2026-10-15)


### Features

* **mcp:** native Playwright browser tool, wired into every session ([#109](https://github.com/Robbertvermeulen/agentboard/issues/109)) ([1ecc9ef](https://github.com/Robbertvermeulen/agentboard/commit/1ecc9ef5228258a44926de8a911e702466dc4e3b))

# [0.24.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.23.0...v0.24.0) (2026-10-15)


### Features

* **runner:** hard claims, the runner assigns one card per session ([#115](https://github.com/Robbertvermeulen/agentboard/issues/115)) ([c952e28](https://github.com/Robbertvermeulen/agentboard/commit/c952e28b41c668e3b690cfafa7d5e3ee7d0ddac9))

# [0.23.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.22.2...v0.23.0) (2026-10-15)


### Features

* **cards:** let the human unblock a card, with a guarded re-block ([#112](https://github.com/Robbertvermeulen/agentboard/issues/112)) ([bd0a953](https://github.com/Robbertvermeulen/agentboard/commit/bd0a953eb580b65c5418a0bbad4adc0cdeedf15d)), closes [#token](https://github.com/Robbertvermeulen/agentboard/issues/token)

## [0.22.2](https://github.com/Robbertvermeulen/agentboard/compare/v0.22.1...v0.22.2) (2026-10-15)


### Bug Fixes

* **runner:** don't start a session for cards a starting session will claim ([#111](https://github.com/Robbertvermeulen/agentboard/issues/111)) ([6caba83](https://github.com/Robbertvermeulen/agentboard/commit/6caba83d276dc48310640a28265f5e4127b1e934)), closes [#328](https://github.com/Robbertvermeulen/agentboard/issues/328) [#329](https://github.com/Robbertvermeulen/agentboard/issues/329) [#110](https://github.com/Robbertvermeulen/agentboard/issues/110)

## [0.22.1](https://github.com/Robbertvermeulen/agentboard/compare/v0.22.0...v0.22.1) (2026-10-15)


### Bug Fixes

* **runner:** give each concurrent session its own cards and workdir ([#110](https://github.com/Robbertvermeulen/agentboard/issues/110)) ([0100b9d](https://github.com/Robbertvermeulen/agentboard/commit/0100b9d827db867f55827dc5d67cf0aa1a506226)), closes [#102](https://github.com/Robbertvermeulen/agentboard/issues/102) [#324](https://github.com/Robbertvermeulen/agentboard/issues/324) [#321](https://github.com/Robbertvermeulen/agentboard/issues/321) [#322](https://github.com/Robbertvermeulen/agentboard/issues/322) [#322](https://github.com/Robbertvermeulen/agentboard/issues/322) [#323](https://github.com/Robbertvermeulen/agentboard/issues/323) [#102](https://github.com/Robbertvermeulen/agentboard/issues/102)

# [0.22.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.21.0...v0.22.0) (2026-10-15)


### Features

* **infra:** add /healthz check for Fly auto-restart ([#108](https://github.com/Robbertvermeulen/agentboard/issues/108)) ([27605dd](https://github.com/Robbertvermeulen/agentboard/commit/27605dd0da493563a7c53ffc23aae9d4994e0e82))

# [0.21.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.20.0...v0.21.0) (2026-10-14)


### Features

* **cards:** change a card's type via CLI and UI ([#106](https://github.com/Robbertvermeulen/agentboard/issues/106)) ([6d4ed21](https://github.com/Robbertvermeulen/agentboard/commit/6d4ed217d2ac508f1d59d59973791e3de9c85e0e))

# [0.20.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.19.1...v0.20.0) (2026-10-11)


### Features

* **runner:** run N sessions concurrently, isolate workdir per slot ([#102](https://github.com/Robbertvermeulen/agentboard/issues/102)) ([2623af8](https://github.com/Robbertvermeulen/agentboard/commit/2623af8f09f6d5fedaff5da513f0b3df9a2a8bd4)), closes [#1](https://github.com/Robbertvermeulen/agentboard/issues/1)

## [0.19.1](https://github.com/Robbertvermeulen/agentboard/compare/v0.19.0...v0.19.1) (2026-09-28)


### Bug Fixes

* **web:** reset scroll to top on real navigation ([#98](https://github.com/Robbertvermeulen/agentboard/issues/98)) ([92612e7](https://github.com/Robbertvermeulen/agentboard/commit/92612e7274767f9eab78685e3c4c3200a7f7423f)), closes [#97](https://github.com/Robbertvermeulen/agentboard/issues/97)

# [0.19.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.18.0...v0.19.0) (2026-09-18)


### Features

* **settings:** agent preferred language, account + board level ([#92](https://github.com/Robbertvermeulen/agentboard/issues/92)) ([a161352](https://github.com/Robbertvermeulen/agentboard/commit/a1613520483fcfd0a55d1df45cac1a97bc866779)), closes [#95](https://github.com/Robbertvermeulen/agentboard/issues/95) [pre-#95](https://github.com/pre-/issues/95)

# [0.18.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.17.0...v0.18.0) (2026-09-18)


### Features

* **sessions:** store per-session usage/cost, replace lock with a pool ([#95](https://github.com/Robbertvermeulen/agentboard/issues/95)) ([3b1bf66](https://github.com/Robbertvermeulen/agentboard/commit/3b1bf66ff8c773cd5d227fa26ddc48b1a71c6b5e)), closes [#1](https://github.com/Robbertvermeulen/agentboard/issues/1)

# [0.17.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.16.0...v0.17.0) (2026-09-17)


### Features

* **routines:** optional check command, run before spawning a session ([#96](https://github.com/Robbertvermeulen/agentboard/issues/96)) ([4f1dfab](https://github.com/Robbertvermeulen/agentboard/commit/4f1dfab57302dce2fceb4aa0a886018d8463c2a2))

# [0.16.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.15.0...v0.16.0) (2026-09-17)


### Features

* **boards:** always-present base board, fallback for card new ([#91](https://github.com/Robbertvermeulen/agentboard/issues/91)) ([d14f4d1](https://github.com/Robbertvermeulen/agentboard/commit/d14f4d1c623cc68640e906f744e5e8e84f931003))

# [0.15.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.14.8...v0.15.0) (2026-09-15)


### Features

* add open-cards dialog when archiving a blocked board ([#85](https://github.com/Robbertvermeulen/agentboard/issues/85)) ([7ec7737](https://github.com/Robbertvermeulen/agentboard/commit/7ec77372e96c15c2654c45f5b7ee6324042647c8))

## [0.14.8](https://github.com/Robbertvermeulen/agentboard/compare/v0.14.7...v0.14.8) (2026-09-15)

## [0.14.7](https://github.com/Robbertvermeulen/agentboard/compare/v0.14.6...v0.14.7) (2026-09-14)


### Bug Fixes

* mark agent sessions with AGENTBOARD_ACTOR so --as/--owner default correctly ([#45](https://github.com/Robbertvermeulen/agentboard/issues/45)) ([68cd41f](https://github.com/Robbertvermeulen/agentboard/commit/68cd41fbb206a4981374df10f4827eeeb33d4443)), closes [#42](https://github.com/Robbertvermeulen/agentboard/issues/42) [#42](https://github.com/Robbertvermeulen/agentboard/issues/42)

## [0.14.6](https://github.com/Robbertvermeulen/agentboard/compare/v0.14.5...v0.14.6) (2026-09-14)

## [0.14.5](https://github.com/Robbertvermeulen/agentboard/compare/v0.14.4...v0.14.5) (2026-09-14)


### Bug Fixes

* **web:** stop blanking the view on realtime ticks ([#78](https://github.com/Robbertvermeulen/agentboard/issues/78)) ([b6231ab](https://github.com/Robbertvermeulen/agentboard/commit/b6231ab6a280bbc585909c26cc65a80dcb77db54)), closes [#77](https://github.com/Robbertvermeulen/agentboard/issues/77) [69/#71](https://github.com/Robbertvermeulen/agentboard/issues/71) [#70](https://github.com/Robbertvermeulen/agentboard/issues/70) [#70](https://github.com/Robbertvermeulen/agentboard/issues/70)

## [0.14.4](https://github.com/Robbertvermeulen/agentboard/compare/v0.14.3...v0.14.4) (2026-09-14)


### Bug Fixes

* **release:** give style commits a patch release ([#81](https://github.com/Robbertvermeulen/agentboard/issues/81)) ([21d4538](https://github.com/Robbertvermeulen/agentboard/commit/21d4538519ae70fbcd1a251d0876efffe6627c67)), closes [#73](https://github.com/Robbertvermeulen/agentboard/issues/73) [#76](https://github.com/Robbertvermeulen/agentboard/issues/76) [#74](https://github.com/Robbertvermeulen/agentboard/issues/74) [#79](https://github.com/Robbertvermeulen/agentboard/issues/79)

## [0.14.3](https://github.com/Robbertvermeulen/agentboard/compare/v0.14.2...v0.14.3) (2026-09-14)


### Bug Fixes

* **web:** preserve scroll position and open column across realtime rerenders ([#70](https://github.com/Robbertvermeulen/agentboard/issues/70)) ([1ff7c94](https://github.com/Robbertvermeulen/agentboard/commit/1ff7c94f1db75abc02d9f0aca75fb806c5a69f8b)), closes [#69](https://github.com/Robbertvermeulen/agentboard/issues/69) [#69](https://github.com/Robbertvermeulen/agentboard/issues/69) [#71](https://github.com/Robbertvermeulen/agentboard/issues/71)

## [0.14.2](https://github.com/Robbertvermeulen/agentboard/compare/v0.14.1...v0.14.2) (2026-09-13)


### Bug Fixes

* **web:** scroll-down button reliably toggles on mobile ([#68](https://github.com/Robbertvermeulen/agentboard/issues/68)) ([3e1bc27](https://github.com/Robbertvermeulen/agentboard/commit/3e1bc2765c8437d64b48a9bd91df822ca7ab1b79)), closes [#63](https://github.com/Robbertvermeulen/agentboard/issues/63)

## [0.14.1](https://github.com/Robbertvermeulen/agentboard/compare/v0.14.0...v0.14.1) (2026-09-13)


### Bug Fixes

* **web:** context tree scales (real collapse, filter, breadcrumb, ellipsis) ([#66](https://github.com/Robbertvermeulen/agentboard/issues/66)) ([94cc027](https://github.com/Robbertvermeulen/agentboard/commit/94cc0274782ee444cc8a80c2a370703167a3fcfa)), closes [#59](https://github.com/Robbertvermeulen/agentboard/issues/59)

# [0.14.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.13.0...v0.14.0) (2026-09-13)


### Features

* **web:** all-boards mobile view reuses detail-board's collapsed-stage columns ([#64](https://github.com/Robbertvermeulen/agentboard/issues/64)) ([eeb61b6](https://github.com/Robbertvermeulen/agentboard/commit/eeb61b605cf7b48472c0beb4a6cce34acdc8b45e))

# [0.13.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.12.2...v0.13.0) (2026-09-13)


### Features

* **web:** floating scroll-down button on card pages ([#63](https://github.com/Robbertvermeulen/agentboard/issues/63)) ([a043763](https://github.com/Robbertvermeulen/agentboard/commit/a04376304635a85fa2f2a35f747c0fab1bc69798))

## [0.12.2](https://github.com/Robbertvermeulen/agentboard/compare/v0.12.1...v0.12.2) (2026-09-13)


### Bug Fixes

* **web:** mobile more-sheet icon and section spacing ([#62](https://github.com/Robbertvermeulen/agentboard/issues/62)) ([35e2b15](https://github.com/Robbertvermeulen/agentboard/commit/35e2b15a0eebf62d7a8b6fed6357e8768e6abfd1))

## [0.12.1](https://github.com/Robbertvermeulen/agentboard/compare/v0.12.0...v0.12.1) (2026-09-13)


### Bug Fixes

* comment scroll always jumps from the top ([#61](https://github.com/Robbertvermeulen/agentboard/issues/61)) ([85205d0](https://github.com/Robbertvermeulen/agentboard/commit/85205d043b8b50b698d45dc4b0da17e8d73e9b9f))

# [0.12.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.11.6...v0.12.0) (2026-09-13)


### Features

* collapsible mobile board sections, drop dead status pills ([#58](https://github.com/Robbertvermeulen/agentboard/issues/58)) ([0a071f8](https://github.com/Robbertvermeulen/agentboard/commit/0a071f82008273d88c2d6e4ae388022d13300047))

## [0.11.6](https://github.com/Robbertvermeulen/agentboard/compare/v0.11.5...v0.11.6) (2026-09-13)


### Bug Fixes

* darker checkmark on selected choice buttons ([#57](https://github.com/Robbertvermeulen/agentboard/issues/57)) ([afdbfe4](https://github.com/Robbertvermeulen/agentboard/commit/afdbfe4343b492ed754ff3da723686ed8ac9f580))
* redesign the new-card modal per issue [#50](https://github.com/Robbertvermeulen/agentboard/issues/50) ([#56](https://github.com/Robbertvermeulen/agentboard/issues/56)) ([2a49b9c](https://github.com/Robbertvermeulen/agentboard/commit/2a49b9ca51eada14cf3cb2a50773bae7358dc49e))

## [0.11.5](https://github.com/Robbertvermeulen/agentboard/compare/v0.11.4...v0.11.5) (2026-09-13)


### Bug Fixes

* board scroll/badge UX + agent-working indicator ([#46](https://github.com/Robbertvermeulen/agentboard/issues/46), [#47](https://github.com/Robbertvermeulen/agentboard/issues/47), [#48](https://github.com/Robbertvermeulen/agentboard/issues/48)) ([#49](https://github.com/Robbertvermeulen/agentboard/issues/49)) ([f387e62](https://github.com/Robbertvermeulen/agentboard/commit/f387e62d25357d6181bde6e4ace281653ecfe94e))

## [0.11.4](https://github.com/Robbertvermeulen/agentboard/compare/v0.11.3...v0.11.4) (2026-09-13)


### Bug Fixes

* **cards:** render choice buttons inside the comment card ([#53](https://github.com/Robbertvermeulen/agentboard/issues/53)) ([6a61907](https://github.com/Robbertvermeulen/agentboard/commit/6a619074e1d6255555860f6e72c49874c29d7475)), closes [#23](https://github.com/Robbertvermeulen/agentboard/issues/23)

## [0.11.3](https://github.com/Robbertvermeulen/agentboard/compare/v0.11.2...v0.11.3) (2026-09-13)


### Bug Fixes

* artifact CSS MIME type + allow scripts in sandboxed HTML ([#52](https://github.com/Robbertvermeulen/agentboard/issues/52)) ([7711ea8](https://github.com/Robbertvermeulen/agentboard/commit/7711ea85a43eaf9226c1656bdbf9aab18deb8467)), closes [#26](https://github.com/Robbertvermeulen/agentboard/issues/26)

## [0.11.2](https://github.com/Robbertvermeulen/agentboard/compare/v0.11.1...v0.11.2) (2026-09-13)


### Bug Fixes

* prevent mobile zoom on form field focus ([#40](https://github.com/Robbertvermeulen/agentboard/issues/40)) ([6307863](https://github.com/Robbertvermeulen/agentboard/commit/6307863ecbf334fd259d218fa6f1107d0f730f48))

## [0.11.1](https://github.com/Robbertvermeulen/agentboard/compare/v0.11.0...v0.11.1) (2026-09-13)


### Bug Fixes

* wrap long links on mobile instead of overflowing ([#44](https://github.com/Robbertvermeulen/agentboard/issues/44)) ([b3171f5](https://github.com/Robbertvermeulen/agentboard/commit/b3171f532e7b7066a663fc6578366381e5f538a9))

# [0.11.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.10.0...v0.11.0) (2026-09-12)


### Features

* clickable choice buttons in card comments ([#36](https://github.com/Robbertvermeulen/agentboard/issues/36)) ([0b64a4c](https://github.com/Robbertvermeulen/agentboard/commit/0b64a4c85605fb176af9cab5cb86d86e5e67a20a))

# [0.10.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.9.0...v0.10.0) (2026-09-12)


### Features

* **boards:** rename and archive boards from the UI and CLI ([#35](https://github.com/Robbertvermeulen/agentboard/issues/35)) ([acb9f6b](https://github.com/Robbertvermeulen/agentboard/commit/acb9f6bd00bbc164bc74a0c34bf7f9fb77bfb3ab))

# [0.9.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.8.0...v0.9.0) (2026-09-12)


### Features

* **mobile:** add board option via dropdown on the New button ([#25](https://github.com/Robbertvermeulen/agentboard/issues/25)) ([7121cb3](https://github.com/Robbertvermeulen/agentboard/commit/7121cb333bdf76271620f592c4a91243a50f9b76)), closes [#18](https://github.com/Robbertvermeulen/agentboard/issues/18)

# [0.8.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.7.0...v0.8.0) (2026-09-12)


### Features

* **board:** convert board tabs to a dropdown ([#33](https://github.com/Robbertvermeulen/agentboard/issues/33)) ([a713db8](https://github.com/Robbertvermeulen/agentboard/commit/a713db8a2424f5060ea3bfba8e440fb98ff9601c))

# [0.7.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.6.0...v0.7.0) (2026-09-12)


### Features

* **links:** auto-link bare http/https urls in descriptions and comments ([#34](https://github.com/Robbertvermeulen/agentboard/issues/34)) ([63130c4](https://github.com/Robbertvermeulen/agentboard/commit/63130c411f17bcb2afb12f9d6c668299794ee8b6))

# [0.6.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.5.1...v0.6.0) (2026-09-12)


### Features

* **update:** manual release check + shorter cache ([#30](https://github.com/Robbertvermeulen/agentboard/issues/30)) ([44e5777](https://github.com/Robbertvermeulen/agentboard/commit/44e577759bcfd13522410b2de0fd40f4c341f4bc)), closes [#29](https://github.com/Robbertvermeulen/agentboard/issues/29)

## [0.5.1](https://github.com/Robbertvermeulen/agentboard/compare/v0.5.0...v0.5.1) (2026-09-12)


### Bug Fixes

* **card:** scroll to new comment after hand-back too ([#28](https://github.com/Robbertvermeulen/agentboard/issues/28)) ([e5cc37d](https://github.com/Robbertvermeulen/agentboard/commit/e5cc37d98105064cb02c2a3e93e67404bfd87790)), closes [#24](https://github.com/Robbertvermeulen/agentboard/issues/24)

# [0.5.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.4.0...v0.5.0) (2026-09-12)


### Features

* **comments:** render inline markdown (incl. links) in card comments ([#27](https://github.com/Robbertvermeulen/agentboard/issues/27)) ([71e2792](https://github.com/Robbertvermeulen/agentboard/commit/71e2792a0b20ce3f203c2c25f3a7cf8bdcdb49cf)), closes [#10](https://github.com/Robbertvermeulen/agentboard/issues/10) [#10](https://github.com/Robbertvermeulen/agentboard/issues/10)

# [0.4.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.3.0...v0.4.0) (2026-09-12)


### Features

* **artifacts:** render .html artifacts inline, sandboxed ([#26](https://github.com/Robbertvermeulen/agentboard/issues/26)) ([f2ebf4b](https://github.com/Robbertvermeulen/agentboard/commit/f2ebf4bee2d6bc4ca7ac18bc0893fd17e695bdd8)), closes [#22](https://github.com/Robbertvermeulen/agentboard/issues/22)

# [0.3.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.2.0...v0.3.0) (2026-09-12)


### Features

* **deploy:** gh cli in the image, session env without server secrets ([#21](https://github.com/Robbertvermeulen/agentboard/issues/21)) ([5359462](https://github.com/Robbertvermeulen/agentboard/commit/535946293c2f3dedcdb843bb29fa2b92a5220904))

# [0.2.0](https://github.com/Robbertvermeulen/agentboard/compare/v0.1.0...v0.2.0) (2026-09-11)


### Features

* **update:** release notice and in-app update ([#20](https://github.com/Robbertvermeulen/agentboard/issues/20)) ([16155ef](https://github.com/Robbertvermeulen/agentboard/commit/16155ef2a87599202f1e551e38071faf01f48b18))
