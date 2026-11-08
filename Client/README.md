# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
    npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Deploy (EAS)

Build numbers (`android.versionCode`, `ios.buildNumber`) are stored on EAS (`cli.appVersionSource: "remote"` in
`eas.json`) and the `production` profile bumps them on every build (`autoIncrement`). The user-facing `version` in
`app.json` is still bumped by hand for each store release.

One-time step before the first remote production build: set the remote build number to the highest one already
uploaded to each store, so the next build goes above it (Play and App Store Connect reject repeated or lower numbers):

```bash
npx eas-cli build:version:set --platform android   # enter the highest versionCode in the Play Console
npx eas-cli build:version:set --platform ios       # enter the highest build number in App Store Connect (if any)
```

`android.versionCode` stays in `app.json` only for local builds (`expo prebuild`, the QA lab's dev clients): EAS ignores
it with the remote source. Lowering it would make `adb install -r` refuse the downgrade over the installed dev build.

### Contact address (`EXPO_PUBLIC_CONTACT_EMAIL`)

The Information screen (Info link on home) shows a "Contact" row only when the build has a valid
`EXPO_PUBLIC_CONTACT_EMAIL`. Expo inlines it into the bundle at build time, and EAS Build does not upload git-ignored
files, so a value in `.env.local` never reaches a store build. Before the first production build, store it in the EAS
`production` environment (plain text: it is shown in the app anyway):

```bash
npx eas-cli env:set --name EXPO_PUBLIC_CONTACT_EMAIL --value <address> --environment production --visibility plaintext
npx eas-cli env:list --environment production   # check it is there
```

The `production` profile in `eas.json` sets no `environment`, so EAS picks `production` from its store distribution
(default). Use the same address as the server's `CONTACT_EMAIL` (`Server/README.md`), shown on `/privacy` and `/terms`.
Deployment checklist: after a store build, open Info on the installed app and check the Contact row and the version.

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
