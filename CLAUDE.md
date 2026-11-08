# ExposeMe

Juego multijugador de fiesta: en cada ronda se muestra una foto aleatoria de la galería de un jugador y el resto adivina de quién es. Publicado en Google Play (Android `com.socketNull.ExposeMe`, iOS con el mismo bundle id), pero **aún sin usuarios reales**: se puede cambiar cualquier cosa (protocolo, comportamiento) sin mantener compatibilidad con versiones anteriores.

## Estructura
- `Client/` — Expo SDK 58, React Native 0.88 (nueva arquitectura), expo-router 58, Node 24 (`Client/.nvmrc`), estilos con twrnc, socket.io-client. `app/` contiene solo rutas de expo-router (layouts, `index.tsx` y pantallas en `app/screens/`); el resto del código va en `src/`: estado global en `src/providers/` (GameContext = socket + sala, PhotoContext = acceso a la galería), componentes en `src/components/`, hooks en `src/hooks/`, utilidades en `src/utils/`, i18n en/es en `src/i18n/` (`__tests__/appRoutes.test.ts` falla si un módulo que no es pantalla vuelve a `app/`). Las carpetas nativas `ios/` y `android/` las genera prebuild en local y NO se versionan (ignoradas en `Client/.gitignore`).
- `Server/` — Express + socket.io, se ejecuta con ts-node. `managers/GameEngine.ts` controla todos los tiempos de la partida (el servidor es la única fuente de verdad, ver `Server/GAME_FLOW.md`), `managers/RoomManager.ts` gestiona salas y jugadores en memoria, `routes/socketRoutes.ts` los eventos de socket, `/upload` guarda las fotos en `Server/temp` durante 30 min.
- `qa/` — Laboratorio de QA: `lab/lab.sh` (dispositivos, servidor, Metro, partidas), `lab/bots.mjs` (jugadores sin interfaz + métricas de sincronización), `maestro/` (flujos en dispositivos), `backlog.json` (gestor de incidencias solo local, fuente de datos del dashboard), `runs/` (artefactos ignorados por git).

## Repositorio público (IMPORTANTE)
Este repo es PÚBLICO en GitHub (RivotX/ExposeMe_mobile-app). Antes de cada commit revisa `git diff --cached --stat` y nunca subas:
- Secretos o credenciales: `.env*`, keystores/certificados (`*.jks`, `*.p12`, `*.p8`, `*.pem`, `*.keystore`), `google-services.json`, `GoogleService-Info.plist`, tokens de EAS/Expo/Render/Apple, API keys. Usa variables de entorno y documéntalas en un `.env.example` con valores de ejemplo.
- Datos personales: fotos reales, contenido de galerías, `Server/temp/`, capturas de pantalla, logs de dispositivos, IPs, UDIDs. Todos los artefactos de QA van en `qa/runs/` (ignorado).
- Detalles de vulnerabilidades: `qa/backlog.json`, `qa/dashboard/*.json`, `qa/dashboard/store/` (datos que se publican en el dashboard), los informes del agente de seguridad y cualquier prueba de concepto se quedan en local (ignorados) hasta que el arreglo esté publicado, y aun así nunca se sube código de explotación. Los mensajes de commit de arreglos de seguridad describen el endurecimiento de forma neutra (p. ej. "[FIX] Validate socket payloads against session"), no cómo explotar el código anterior.
- Cambios de configuración de producción (URL del servidor, bundle ids, configuración de tiendas/EAS) sin aprobación del usuario.
Si alguna vez se sube algo sensible, para y avisa al usuario (rotar credenciales y reescribir el historial es decisión suya); nunca hagas force-push por tu cuenta.

## Comandos
- Servidor: `cd Server && npm run dev` (puerto 3000). Tipos: `npx tsc --noEmit`. Tests: `npx vitest run`.
- Cliente: `cd Client && EXPO_PUBLIC_SERVER_URL=http://localhost:3000 npx expo start --dev-client`. Tipos: `npx tsc --noEmit`. Tests: `npx jest --ci`.
- Laboratorio: `qa/lab/lab.sh` (ver `.claude/skills/exposeme-device-lab/SKILL.md`).
- `Client/config.ts` usa el servidor de producción (Render) si `EXPO_PUBLIC_SERVER_URL` no está definida. Nunca dirijas tráfico de QA a producción.

## Convenciones
- Idioma: todo lo que lee el usuario (respuestas, dashboard, textos del backlog) en español. El código, los comentarios del código y los mensajes de commit, en inglés.
- Mensajes de commit: `[FIX] …`, `[FEAT] …`, `[TEST] …`, `[CHORE] …`. Nunca añadas `Co-Authored-By: Claude` ni ninguna atribución a IA.
- Estilo de código: componentes funcionales + hooks, clases twrnc `tw\`…\``, separadores de sección cortos (`// ── Nombre ──`) en ficheros largos.
- Cualquier cambio en el protocolo de sockets actualiza a la vez servidor, cliente, `Server/GAME_FLOW.md` y `qa/lab/bots.mjs`.
- El cliente nunca lleva sus propios temporizadores de partida: pinta las fases del servidor con la `duration` que recibe.

## Bucle de QA
El flujo autónomo de arreglos y pulido es la skill `exposeme-qa-loop` (`/exposeme-qa-loop`, o `/loop /exposeme-qa-loop`). Subagentes: `qa-auditor`, `qa-fixer`, `qa-reviewer`, `qa-security` y `qa-device-tester`, en `.claude/agents/`. Se trabaja en la rama `qa/loop` y el progreso se publica en el dashboard de QA: https://claude.ai/artifact/Tymg6zZ1y6Mdb1Z29eaTui. Las preguntas al usuario van al dashboard como tarjetas, y él responde con comentarios.

## reglas
1. Si no sabes algo no inventes, investiga en internet
2. nunca me des la razon por que sí, se siempre critico y busca la verdad
