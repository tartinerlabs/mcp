## [0.32.1](https://github.com/tartinerlabs/mcp/compare/v0.32.0...v0.32.1) (2026-11-27)

### Bug Fixes

* **aso:** stop false keyword errors in CJK ([05a0e3e](https://github.com/tartinerlabs/mcp/commit/05a0e3e3635a4e7acbb95200c020d39841ada2ac))

## [0.32.0](https://github.com/tartinerlabs/mcp/compare/v0.31.2...v0.32.0) (2026-11-27)

### Features

* **asc:** add remaining versions check checks ([0a4f00f](https://github.com/tartinerlabs/mcp/commit/0a4f00f704485fbedbec347167e65d61c523d6b3))

### Bug Fixes

* **asc:** count keyword characters in lint ([7e1447b](https://github.com/tartinerlabs/mcp/commit/7e1447bcdd360fa7a20c7faf93cb5084cc5844d2))

## [0.31.2](https://github.com/tartinerlabs/mcp/compare/v0.31.1...v0.31.2) (2026-11-27)

### Bug Fixes

* **asc:** stop false blockers in versions check ([a4cc888](https://github.com/tartinerlabs/mcp/commit/a4cc88843057611df8b601bb7d4ca9c940c944ac))

## [0.31.1](https://github.com/tartinerlabs/mcp/compare/v0.31.0...v0.31.1) (2026-11-27)

### Bug Fixes

* **asc:** include relationships commands read ([80eb173](https://github.com/tartinerlabs/mcp/commit/80eb1737c23bfdc92072b97a72859406356d2604))

## [0.31.0](https://github.com/tartinerlabs/mcp/compare/v0.30.0...v0.31.0) (2026-11-27)

### Features

* **asc:** add EU alternative distribution commands ([9bfaa3e](https://github.com/tartinerlabs/mcp/commit/9bfaa3efe3ee3f588c1a3281bf405af10b1bdf3c)), closes [#151](https://github.com/tartinerlabs/mcp/issues/151)
* **asc:** add Game Center leaderboards and achievements ([bc81adb](https://github.com/tartinerlabs/mcp/commit/bc81adb936e8a9de6398a20299bf27eeefbd5f66)), closes [#148](https://github.com/tartinerlabs/mcp/issues/148)
* **asc:** add shell completion ([6da6ff8](https://github.com/tartinerlabs/mcp/commit/6da6ff877a26993be131798fca3568ff824a1153)), closes [#143](https://github.com/tartinerlabs/mcp/issues/143)
* **asc:** add TestFlight setup and dSYM downloads ([c0c538f](https://github.com/tartinerlabs/mcp/commit/c0c538f1d707d634ab0f91c5af00eeecc332237d)), closes [#129](https://github.com/tartinerlabs/mcp/issues/129) [#130](https://github.com/tartinerlabs/mcp/issues/130) [#131](https://github.com/tartinerlabs/mcp/issues/131) [#140](https://github.com/tartinerlabs/mcp/issues/140)
* **asc:** add versions check ([bd65f03](https://github.com/tartinerlabs/mcp/commit/bd65f0385a7322eb58aee04db51118142ed13fca)), closes [#128](https://github.com/tartinerlabs/mcp/issues/128)
* **asc:** add versions create and set ([1373e90](https://github.com/tartinerlabs/mcp/commit/1373e90005458fa310a13260eb5d7a3a1b0a13ee)), closes [#125](https://github.com/tartinerlabs/mcp/issues/125)
* **asc:** create and price products and offers ([b1fc3fc](https://github.com/tartinerlabs/mcp/commit/b1fc3fc514ebae1cbcc4736cb0e8ccbf1427f0fb)), closes [#136](https://github.com/tartinerlabs/mcp/issues/136) [#137](https://github.com/tartinerlabs/mcp/issues/137) [#138](https://github.com/tartinerlabs/mcp/issues/138)
* **asc:** install signing into a keychain ([18c4014](https://github.com/tartinerlabs/mcp/commit/18c401430bfe150ee506ed1506295135df89ed4a)), closes [#134](https://github.com/tartinerlabs/mcp/issues/134)
* **asc:** manage App Clip experiences ([53de8d3](https://github.com/tartinerlabs/mcp/commit/53de8d3f94f44392c6acdb174d842b5525fe4c66)), closes [#147](https://github.com/tartinerlabs/mcp/issues/147)
* **asc:** manage App Review details ([b118b82](https://github.com/tartinerlabs/mcp/commit/b118b8206bcb52ef761bf7d6379b830eed7d58b7)), closes [#127](https://github.com/tartinerlabs/mcp/issues/127)
* **asc:** manage sandbox testers ([c6eb2bf](https://github.com/tartinerlabs/mcp/commit/c6eb2bf7b8abdbf0d9b5fb76c9a53a82411081e3)), closes [#145](https://github.com/tartinerlabs/mcp/issues/145)
* **asc:** manage users and invitations ([bdf7291](https://github.com/tartinerlabs/mcp/commit/bdf7291f7dc1a2848d9e80e5bfe730e53491eb28)), closes [#144](https://github.com/tartinerlabs/mcp/issues/144)
* **asc:** manage webhooks and deliveries ([d38a720](https://github.com/tartinerlabs/mcp/commit/d38a720e2106581241e05a3798ef9b155a38dc38)), closes [#146](https://github.com/tartinerlabs/mcp/issues/146)
* **asc:** notarize macOS builds ([f461377](https://github.com/tartinerlabs/mcp/commit/f461377f621dcaee71962fee1b6f1d5147b59e17)), closes [#135](https://github.com/tartinerlabs/mcp/issues/135)
* **asc:** pull, push and lint App Store metadata ([d076d2e](https://github.com/tartinerlabs/mcp/commit/d076d2e0642a2c1c3caf40088aa10b61aae9796d)), closes [#123](https://github.com/tartinerlabs/mcp/issues/123) [#124](https://github.com/tartinerlabs/mcp/issues/124)
* **asc:** register bundle IDs, capabilities, devices ([c302ccd](https://github.com/tartinerlabs/mcp/commit/c302ccd1711a9abc2af99cb0945ca0774686de4e)), closes [#132](https://github.com/tartinerlabs/mcp/issues/132)
* **asc:** send raw requests to the API ([4b1c2f3](https://github.com/tartinerlabs/mcp/commit/4b1c2f3821c5d5be2f351c6cb377833de2636ce9)), closes [#142](https://github.com/tartinerlabs/mcp/issues/142)
* **asc:** set categories and content rights ([8e35887](https://github.com/tartinerlabs/mcp/commit/8e358871523971abc4618cfdc00e3b3077f97072)), closes [#126](https://github.com/tartinerlabs/mcp/issues/126)
* **asc:** share signing via encrypted git store ([77c1ae6](https://github.com/tartinerlabs/mcp/commit/77c1ae6efc5ba64ef5291b0620538821b4dba75a)), closes [#133](https://github.com/tartinerlabs/mcp/issues/133)
* **asc:** start and rerun Xcode Cloud builds ([280cd24](https://github.com/tartinerlabs/mcp/commit/280cd249bd27a1c18afb1d5de2eea256b8574c86)), closes [#141](https://github.com/tartinerlabs/mcp/issues/141)
* **asc:** submit featuring nominations ([5b6f9f9](https://github.com/tartinerlabs/mcp/commit/5b6f9f918e00ab4c53f03cd6dac4b1cc02b5912e)), closes [#150](https://github.com/tartinerlabs/mcp/issues/150)
* **asc:** upload background asset packs ([0887006](https://github.com/tartinerlabs/mcp/commit/0887006e86b7c2e9e8563f886649dc168baf06c3)), closes [#149](https://github.com/tartinerlabs/mcp/issues/149)

## [0.30.0](https://github.com/tartinerlabs/mcp/compare/v0.29.0...v0.30.0) (2026-11-27)

### Features

* **asc:** summarise sales, finance and analytics ([95c0f00](https://github.com/tartinerlabs/mcp/commit/95c0f0046f038e6b345b538cc5ffd0a206f1f1f5)), closes [#34](https://github.com/tartinerlabs/mcp/issues/34) [#35](https://github.com/tartinerlabs/mcp/issues/35)

### Bug Fixes

* **asc:** keep one PermissionError after merging main ([55ba51a](https://github.com/tartinerlabs/mcp/commit/55ba51a2e3d5e91da93a19598f985caf609a2ae9))

## [0.29.0](https://github.com/tartinerlabs/mcp/compare/v0.28.0...v0.29.0) (2026-11-27)

### Features

* **asc:** manage certificates and profiles ([40a5636](https://github.com/tartinerlabs/mcp/commit/40a56369cff93d673f76770959e2650f6abd8102)), closes [#62](https://github.com/tartinerlabs/mcp/issues/62) [#99](https://github.com/tartinerlabs/mcp/issues/99)

## [0.28.0](https://github.com/tartinerlabs/mcp/compare/v0.27.0...v0.28.0) (2026-11-27)

### Features

* **asc:** read perf metrics and Xcode Cloud runs ([a0a4d6e](https://github.com/tartinerlabs/mcp/commit/a0a4d6e437e90b1986555adc6f04e463f5c11668)), closes [#65](https://github.com/tartinerlabs/mcp/issues/65) [#66](https://github.com/tartinerlabs/mcp/issues/66)

### Bug Fixes

* **asc:** keep one PermissionError after merging main ([f105f1a](https://github.com/tartinerlabs/mcp/commit/f105f1a7b50395345f7490eeb0b6c655a4b79c70))

## [0.27.0](https://github.com/tartinerlabs/mcp/compare/v0.26.0...v0.27.0) (2026-11-27)

### Features

* **asc:** add version submit, release and cancel ([e0e550c](https://github.com/tartinerlabs/mcp/commit/e0e550c05458c8a30eafe9e5baf13b6c1928b352)), closes [#36](https://github.com/tartinerlabs/mcp/issues/36) [#96](https://github.com/tartinerlabs/mcp/issues/96)

## [0.26.0](https://github.com/tartinerlabs/mcp/compare/v0.25.0...v0.26.0) (2026-11-27)

### Features

* **asc:** add in-app purchase and subscription views ([889ed85](https://github.com/tartinerlabs/mcp/commit/889ed859065e4d229af7ec0b17c97b16d285a120)), closes [#67](https://github.com/tartinerlabs/mcp/issues/67)

## [0.25.0](https://github.com/tartinerlabs/mcp/compare/v0.24.0...v0.25.0) (2026-11-27)

### Features

* **asc:** upload builds through the API ([89374b2](https://github.com/tartinerlabs/mcp/commit/89374b24702da9995594a482230f304266767cfd)), closes [#98](https://github.com/tartinerlabs/mcp/issues/98)

## [0.24.0](https://github.com/tartinerlabs/mcp/compare/v0.23.0...v0.24.0) (2026-11-27)

### Features

* **asc:** submit builds for beta review and expire ([4588b81](https://github.com/tartinerlabs/mcp/commit/4588b81f4b057ceeda61740fc43a554e26571790)), closes [#94](https://github.com/tartinerlabs/mcp/issues/94)

## [0.23.0](https://github.com/tartinerlabs/mcp/compare/v0.22.0...v0.23.0) (2026-11-22)

### Features

* **aso:** add keyword lint, rank and competitor CLI ([4224559](https://github.com/tartinerlabs/mcp/commit/4224559f55c6429a2b2ffbcdbe139b46db12a72f))

## [0.22.0](https://github.com/tartinerlabs/mcp/compare/v0.21.0...v0.22.0) (2026-11-21)

### Features

* **asc:** manage custom product pages ([bc3db77](https://github.com/tartinerlabs/mcp/commit/bc3db77225894d0af0fae1e7ee5b9e24f77335a2))
* **asc:** manage in-app events ([15602cd](https://github.com/tartinerlabs/mcp/commit/15602cd674375f0f8063d4edf41ae4e6a3f946e6))
* **asc:** read and edit version metadata and app info localisations ([b211920](https://github.com/tartinerlabs/mcp/commit/b2119206c22f8a25a112033300400dc0f88814ef))
* **asc:** read pricing and manage availability and age rating ([a8ae5e1](https://github.com/tartinerlabs/mcp/commit/a8ae5e15ed987f0558294c18d9caaa8a27070785))
* **asc:** run product page optimization tests ([0c0de58](https://github.com/tartinerlabs/mcp/commit/0c0de58f18c19cfccb2cd38155ca1b1339388afc))
* **asc:** upload screenshots and app previews ([06e854c](https://github.com/tartinerlabs/mcp/commit/06e854cc4d878215aef37a582376345911f1f4a2))

## [0.21.0](https://github.com/tartinerlabs/mcp/compare/v0.20.0...v0.21.0) (2026-11-21)

### Features

* **asc:** write TestFlight notes, testers and group builds ([e632fa7](https://github.com/tartinerlabs/mcp/commit/e632fa7659246ad5abbee7bd04c10214bc1bb8e5))

## [0.20.0](https://github.com/tartinerlabs/mcp/compare/v0.19.0...v0.20.0) (2026-11-21)

### Features

* **asc:** read TestFlight groups, testers and feedback ([958a000](https://github.com/tartinerlabs/mcp/commit/958a000a96da620139d9f80ba1fcad4f9b2cb263))

## [0.19.0](https://github.com/tartinerlabs/mcp/compare/v0.18.1...v0.19.0) (2026-11-21)

### Features

* **asc:** set export compliance on builds ([83b8534](https://github.com/tartinerlabs/mcp/commit/83b85343038f4af52aae2262c564d90f0161f9ae))

## [0.18.1](https://github.com/tartinerlabs/mcp/compare/v0.18.0...v0.18.1) (2026-11-21)

### Bug Fixes

* name pnpm skills dir for clean installs ([c11044f](https://github.com/tartinerlabs/mcp/commit/c11044f811c2b971eb512f003e3796dcec823c22))

## [0.18.0](https://github.com/tartinerlabs/mcp/compare/v0.17.0...v0.18.0) (2026-11-21)

### Features

* **asc:** reply to and delete review responses ([9533dd9](https://github.com/tartinerlabs/mcp/commit/9533dd944602823420f01040e211c8214aa89b5e))

## [0.17.0](https://github.com/tartinerlabs/mcp/compare/v0.16.0...v0.17.0) (2026-11-21)

### Features

* **asc:** add status command ([246c242](https://github.com/tartinerlabs/mcp/commit/246c242acddad7e0fdfef60877cf32ba42c84d42))

## [0.16.0](https://github.com/tartinerlabs/mcp/compare/v0.15.0...v0.16.0) (2026-11-21)

### Features

* **asc:** add builds wait command ([a4f8451](https://github.com/tartinerlabs/mcp/commit/a4f8451ca6d73be62666fdef3e20bbb3033f73f3))

## [0.15.0](https://github.com/tartinerlabs/mcp/compare/v0.14.1...v0.15.0) (2026-11-21)

### Features

* **asc:** add cursor pagination to list commands ([f88d9be](https://github.com/tartinerlabs/mcp/commit/f88d9bedc5dedb309aaaa8ff773fa73cf797eb76))

## [0.14.1](https://github.com/tartinerlabs/mcp/compare/v0.14.0...v0.14.1) (2026-11-15)


### Bug Fixes

* **core:** refuse subscriptions/listen streams ([293e752](https://github.com/tartinerlabs/mcp/commit/293e752fe7735906851ed25a42f64b8006bb80b4))

# [0.14.0](https://github.com/tartinerlabs/mcp/compare/v0.13.0...v0.14.0) (2026-11-12)


### Features

* **asc:** replace MCP server with CLI ([ef48f37](https://github.com/tartinerlabs/mcp/commit/ef48f37c9eed3938990c844b185e81195f5e3543))

# [0.13.0](https://github.com/tartinerlabs/mcp/compare/v0.12.0...v0.13.0) (2026-11-12)


### Bug Fixes

* report Bing's unset values as null ([d0290e1](https://github.com/tartinerlabs/mcp/commit/d0290e1f3e749eabbb4d8c41ec011500bc623a78))


### Features

* add Bing Webmaster MCP server ([407c453](https://github.com/tartinerlabs/mcp/commit/407c4536074abba3075435044b8fae391a1beaea))
* add initial Bing database migration ([61f7edd](https://github.com/tartinerlabs/mcp/commit/61f7eddff15a44f1e6208ea9f77bb22bca4da005))
* document Bing MCP server ([20642ad](https://github.com/tartinerlabs/mcp/commit/20642ad2a75e43c79da0d367021a725b088a220e))
* host Bing MCP on Vercel ([7f603b3](https://github.com/tartinerlabs/mcp/commit/7f603b314a409fab17c62d42a012735cb321e112))
* **index-now:** rely on root devEngines ([0cc91b1](https://github.com/tartinerlabs/mcp/commit/0cc91b12c71a3322fb7d760adaa8aa89c176b124))
* **index-now:** replace MCP server with CLI ([53e8a59](https://github.com/tartinerlabs/mcp/commit/53e8a5914d6b4db5f98fb96f33c7e312ec508e41))
* **index-now:** run IndexNow MCP locally ([21a4930](https://github.com/tartinerlabs/mcp/commit/21a493059eede9509af645d64a324728f20f5a92))

# [0.12.0](https://github.com/tartinerlabs/mcp/compare/v0.11.0...v0.12.0) (2026-10-25)


### Features

* add App Store keyword research server ([04fd0df](https://github.com/tartinerlabs/mcp/commit/04fd0df289094c987256318ac40cad7148a95243))
* document aso build watch paths ([c53066f](https://github.com/tartinerlabs/mcp/commit/c53066f5af9f50425be46183ea030fc5c5a6f2c7))
* serve aso on a custom domain ([a1342e7](https://github.com/tartinerlabs/mcp/commit/a1342e75c38d51097f5d4f0cf589c31f23e677e9))

# [0.11.0](https://github.com/tartinerlabs/mcp/compare/v0.10.1...v0.11.0) (2026-10-25)


### Features

* serve asc and index-now on mcp subdomains ([315d6b0](https://github.com/tartinerlabs/mcp/commit/315d6b0b65c93f6865175fa6e8b88cd230d66d11))

## [0.10.1](https://github.com/tartinerlabs/mcp/compare/v0.10.0...v0.10.1) (2026-10-25)


### Bug Fixes

* bind asc D1 database by name ([33f4b76](https://github.com/tartinerlabs/mcp/commit/33f4b7610933f165f482441c09c59378df0e1fe9))

# [0.10.0](https://github.com/tartinerlabs/mcp/compare/v0.9.0...v0.10.0) (2026-10-25)


### Features

* add App Store Connect MCP server on Workers ([aa65414](https://github.com/tartinerlabs/mcp/commit/aa6541440861961fc024bdb0860a7bd98a77fcb2)), closes [#28](https://github.com/tartinerlabs/mcp/issues/28)
* add db:push script for asc ([289c2e5](https://github.com/tartinerlabs/mcp/commit/289c2e537a6ef5d6b17c2c7aede05d768dcdaaf8))
* add initial asc migration ([be00a6b](https://github.com/tartinerlabs/mcp/commit/be00a6b70dbc71ce3bcec3f41422e1193fa20d4a))
* add shared Apple key storage and signing ([5f3c72c](https://github.com/tartinerlabs/mcp/commit/5f3c72ce7ac4d4e106f81739a076a6c62b9f393d)), closes [#63](https://github.com/tartinerlabs/mcp/issues/63)
* deploy asc with wrangler like index-now ([15b0311](https://github.com/tartinerlabs/mcp/commit/15b0311963186899052f25dd64d5a961ee0f6875))
* drop allowed hosts vars from asc config ([5ffe3ff](https://github.com/tartinerlabs/mcp/commit/5ffe3ff3530a7d4355f4becfdea65f2e7e828f8d))
* drop allowed origins var from asc config ([c70bca3](https://github.com/tartinerlabs/mcp/commit/c70bca36771f39c0a7111b6bdb61f5b83c101d43))
* run core on Node and Cloudflare Workers ([b5884c8](https://github.com/tartinerlabs/mcp/commit/b5884c8c9dc07eb92f86f486cf31bf6308d09863)), closes [#41](https://github.com/tartinerlabs/mcp/issues/41)

# [0.9.0](https://github.com/tartinerlabs/mcp/compare/v0.8.0...v0.9.0) (2026-10-22)


### Bug Fixes

* fail fast when IndexNow rate-limits ([1f2a61f](https://github.com/tartinerlabs/mcp/commit/1f2a61fc7428c8616817647af2720f07ac543622))


### Features

* queue IndexNow submissions in the background ([1dbbf09](https://github.com/tartinerlabs/mcp/commit/1dbbf09f864571623fe812cbb66d98c9540f668f))
* run IndexNow submissions as Workflows ([37e84b2](https://github.com/tartinerlabs/mcp/commit/37e84b2322ed7ec47bb522e081deda64ce191a48))

# [0.8.0](https://github.com/tartinerlabs/mcp/compare/v0.7.1...v0.8.0) (2026-10-21)


### Features

* deploy IndexNow MCP on Cloudflare Workers ([40519c1](https://github.com/tartinerlabs/mcp/commit/40519c1fc83661ea8fbc6a8cf5c9442b9ee73b50))

## [0.7.1](https://github.com/tartinerlabs/mcp/compare/v0.7.0...v0.7.1) (2026-10-21)


### Bug Fixes

* report package version from package.json ([f9b1259](https://github.com/tartinerlabs/mcp/commit/f9b1259f7a9db68437bf81bcc67fb83b4f63f690))

# [0.7.0](https://github.com/tartinerlabs/mcp/compare/v0.6.1...v0.7.0) (2026-10-21)


### Features

* add IndexNow MCP server ([377c31d](https://github.com/tartinerlabs/mcp/commit/377c31db68d8c1fe26ac9f92544317c315a271d2))

## [0.6.1](https://github.com/tartinerlabs/mcp/compare/v0.6.0...v0.6.1) (2026-10-20)


### Bug Fixes

* always show google account chooser ([b6a13d1](https://github.com/tartinerlabs/mcp/commit/b6a13d1df28670a237a7d9b9576faa1746f824e0))

# [0.6.0](https://github.com/tartinerlabs/mcp/compare/v0.5.0...v0.6.0) (2026-10-20)


### Features

* restyle OAuth pages ([c6980af](https://github.com/tartinerlabs/mcp/commit/c6980af0f7060c23632ca6f5772685438d1c27ba))

# [0.5.0](https://github.com/tartinerlabs/mcp/compare/v0.4.1...v0.5.0) (2026-10-20)


### Bug Fixes

* reject legacy clients, fix CrUX ratings ([9f56062](https://github.com/tartinerlabs/mcp/commit/9f56062a3050c5170e24b29663e37c3b77a3f640))


### Features

* add optional sitemap write scope and CIMD host allow-list ([2ad5acb](https://github.com/tartinerlabs/mcp/commit/2ad5acbe32e0df65766330a84af8ba5df9385ed4))

## [0.4.1](https://github.com/tartinerlabs/mcp/compare/v0.4.0...v0.4.1) (2026-10-20)


### Bug Fixes

* release idle db connections on fluid compute ([5791d8a](https://github.com/tartinerlabs/mcp/commit/5791d8a649e10bac09eceeb1ea91f72cfc810c31))

# [0.4.0](https://github.com/tartinerlabs/google-search-console-mcp/compare/v0.3.0...v0.4.0) (2026-10-20)


### Features

* add pagespeed insights mcp server ([a47b3bd](https://github.com/tartinerlabs/google-search-console-mcp/commit/a47b3bd37802dbe6a59498e8c39a758560fb1a51))

# [0.3.0](https://github.com/tartinerlabs/google-search-console-mcp/compare/v0.2.0...v0.3.0) (2026-10-20)


### Features

* add root status endpoint ([c32b055](https://github.com/tartinerlabs/google-search-console-mcp/commit/c32b055b9964d6eb5f3dc5e3dd9ddea9a3931a1f))
