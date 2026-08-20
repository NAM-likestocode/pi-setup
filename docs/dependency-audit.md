# Dependency audit status

Last reviewed: 2026-08-20

After updating the directly controlled `ws` dependency to 8.21.3 and the visual planner's Vite dependency to 6.4.3, `npm audit` reports:

- 0 critical
- 7 high
- 12 moderate

The remaining advisories are in the Expo 53 / React Native 0.79 mobile build chain, including Metro, PostCSS, `image-size`, `uuid`, and `xcode` transitive dependencies. npm's available remediation moves the app to Expo 57 and React Native 0.86, which is a breaking framework migration rather than a safe patch update.

## Current boundary

- Mobile builds must use trusted repository source and trusted image/style assets.
- Do not expose the Metro development server to untrusted networks.
- Do not run `npm audit fix --force`; it can partially upgrade the framework and leave native Android/iOS sources inconsistent.
- The committed Android release manifest explicitly removes storage, microphone, and overlay permissions that Pimo does not need.
- The Android release build and merged manifest are validated with JDK 17.

## Required follow-up

Migrate Expo and React Native together in a dedicated change, regenerate native projects, review permission diffs, and rerun:

```bash
npm run typecheck
npm test
npm run mobile:typecheck
cd apps/anywhere-mobile/android
NODE_ENV=production ./gradlew :app:assembleRelease
```

Do not mark the audit debt resolved until a root-level `npm audit` confirms the findings are gone or each remaining advisory has been reassessed against the upgraded dependency graph.
