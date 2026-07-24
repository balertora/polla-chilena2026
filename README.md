# ★ La Polla Chilena

Predictor de la Primera División de Chile entre amigos. Hermana de La Polla Mundial.

## Reglas
- **Marcador exacto**, **resultado correcto** y **penalización por no predecir**
  tienen puntajes configurables desde el panel Admin (por defecto: 5 / 3 / −1).
- **Ganador de la Fecha**: bonus (por defecto +1) al mayor puntaje de cada fecha
  completa; los empates comparten el bonus. También configurable.
- Quien llega tarde parte con los puntos del último lugar al momento de registrarse.
- Desempates: Total → Exactos → Resultados correctos.
- Cada partido se puede predecir hasta que comienza; los pronósticos de los demás
  se revelan recién al inicio de cada partido (anti-copia).
- El admin fija una **fecha de inicio de la polla**: los partidos anteriores no se
  muestran ni suman/restan puntos (útil para arrancar a mitad de temporada).

## Stack
- Node 18+ · Express · SQLite · WebSocket
- Cliente de una sola página (`client.html`), servido por el mismo servidor.
- **Fixture + resultados**: se sincronizan desde el CSV público de TheSportsDB
  (`/season/<id>-chile-primera-division/<temporada>?csv=1&all=1`), que trae la
  temporada completa. Corre solo en el arranque y cada 6 h.
- **Marcadores en vivo**: ESPN scoreboard público (`chi.1`), sin key. El
  emparejamiento de nombres de equipo está verificado para los 16 clubes.
- **Escudos**: hardcodeados en el cliente (mapa `TEAM_BADGES`), estáticos, sin
  llamadas a API.
- **Respaldo manual completo** desde el panel Admin: importar CSV pegado,
  agregar/editar partidos, cargar resultados a mano, marcar suspendidos. Un
  resultado cargado a mano (`result_source='admin'`) nunca lo pisa la sync.

## Deploy (Railway)
1. Sube este repo a GitHub y crea un servicio en Railway apuntándolo ahí.
2. Agrega un **Volume** montado en `/data` y setea la variable `DB_PATH=/data/polla.db`
   (si no, la base de datos se borra en cada deploy).
3. Deploy — el primer usuario registrado queda como **admin**.
4. En **Settings → Networking**, genera el dominio público (puerto 3000).
5. En Admin → Sincronización: verifica el league ID (**`4627`** = Primera División
   de Chile en TheSportsDB) y la temporada (`2026`), y aprieta **Sincronizar
   fixture ahora**. Si algo falla, usa **🔍 Diagnóstico** o la importación de CSV.
6. En Admin → **Inicio de la polla**, fija desde cuándo cuenta la polla.
7. En Admin → **Puntaje**, ajusta los valores si quieres cambiarlos.

> **Nota sobre el arranque:** el `Procfile` (`web: node server.js`) hace que Railway
> ejecute Node directamente en vez de `npm start`. Esto es necesario para que el
> proceso reciba la señal `SIGTERM` en cada redeploy y se apague limpio — de lo
> contrario Railway lo marca como "crashed" y manda un mail de falso error.

## Recuperación de contraseña
Al registrarse, cada usuario recibe un **código de recuperación** (se muestra una sola
vez). Con ese código puede restablecer su contraseña desde "Olvidé mi contraseña".
El admin puede generar un código nuevo para cualquier usuario desde el panel.

## Aviso de nueva versión
El servidor inyecta un hash de versión en `client.html` y lo envía en cada actualización
de estado. Si una pestaña abierta quedó con un build viejo tras un deploy, muestra un
banner "hay una nueva version disponible — toca para actualizar". También hay un
indicador de reconexión cuando se cae y vuelve el WebSocket.

## Desarrollo local
```bash
npm install
npm start   # http://localhost:3000
```
