# ★ La Polla Chilena

Predictor de la Primera División de Chile entre amigos. Hermana de La Polla Mundial.

## Reglas
- **5 pts** marcador exacto · **3 pts** resultado correcto · **0** equivocado
- **−1 pt** por partido que se te olvidó predecir (solo partidos posteriores a tu registro)
- **+1 pt** al **Ganador de la Fecha** (mayor puntaje de la ronda; empates comparten el punto)
- Quien llega tarde parte con los puntos del último lugar al momento de registrarse
- Desempates: Total → Exactos → Resultados correctos
- Cada partido se puede predecir hasta que comienza; los pronósticos de los demás
  se revelan recién al inicio de cada partido

## Stack
- Node 18+ · Express · SQLite · WebSocket
- Fixture y resultados finales: **TheSportsDB** (API gratis, key pública `123`)
- Marcadores en vivo: **ESPN** scoreboard público (`chi.1`), sin key
- Respaldo manual completo desde el panel Admin (agregar/editar partidos y resultados)

## Deploy (Railway)
1. Sube este repo a GitHub y crea un servicio en Railway apuntándolo ahí
2. Agrega un **Volume** montado en `/data` y setea la variable `DB_PATH=/data/polla.db`
   (si no, la base se borra en cada deploy)
3. Deploy — el primer usuario registrado queda como **admin**
4. En Admin → Sincronización: verifica league ID (`4478` = Primera División de Chile
   en TheSportsDB) y temporada (`2026`), y aprieta **Sincronizar fixture ahora**

## Recuperación de contraseña
Al registrarse, cada usuario recibe un **código de recuperación** (se muestra una sola
vez). Con ese código puede restablecer su contraseña desde "Olvidé mi contraseña".
El admin puede generar un código nuevo para cualquier usuario desde el panel.

## Desarrollo local
```bash
npm install
npm start   # http://localhost:3000
```
