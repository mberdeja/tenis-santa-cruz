# 🏓 Tenis de Mesa Santa Cruz

Sistema de gestión de torneos de tenis de mesa para la **Asociación Departamental de Tenis de Mesa Santa Cruz**.

🌐 **App en vivo:** [tenis-santa-cruz.vercel.app](https://tenis-santa-cruz.vercel.app)

---

## 📋 Funcionalidades

### Formatos de torneo
- **Por grupos** — fase de grupos + eliminación directa (cuartos, semis, final y 3° puesto)
- **Todos contra todos** — round robin completo, tabla de posiciones con desempate por head-to-head
- **Liga** — 12 jugadores, 2 grupos de 6, clasificación por posición (1°A vs 1°B, 2°A vs 2°B... hasta el 6°)

### Gestión de partidos
- Carga de resultados set a set (al mejor de 5, mínimo 11 puntos con ventaja de 2)
- Walk Over simple (un jugador ausente)
- Doble Walk Over (ningún jugador se presentó)
- Nombre del árbitro obligatorio por partido
- Sorteo aleatorio de grupos (una sola vez, se bloquea)
- Asignación manual de cruces en eliminatorias

### Roles de usuario
| Rol | Crear torneos | Cargar resultados | Gestionar usuarios |
|-----|:---:|:---:|:---:|
| Admin | ✅ | ✅ | ✅ |
| Árbitro | ❌ | ✅ | ❌ |
| Lector | ❌ | ❌ | ❌ |

### Otras funciones
- Ranking general con estadísticas acumuladas (grupos + eliminatorias)
- Desempate por head-to-head en fase de grupos
- Historial de partidos con filtro por jugador
- Renombrar torneo (solo Admin)
- Múltiples torneos simultáneos
- Sincronización en tiempo real entre dispositivos

---

## 🛠️ Stack tecnológico

| Tecnología | Uso |
|------------|-----|
| React + Vite | Frontend |
| Firebase Firestore | Base de datos en tiempo real |
| Firebase Authentication | Autenticación de usuarios |
| Vercel | Hosting y deploy automático |

---

## 🚀 Setup local

### Requisitos
- Node.js v18+
- Cuenta de Firebase

### Instalación

```bash
# Clonar el repositorio
git clone https://github.com/mberdeja/tenis-santa-cruz.git
cd tenis-santa-cruz

# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales de Firebase

# Correr en desarrollo
npm run dev
```

### Variables de entorno

Crear un archivo `.env` con las credenciales de Firebase:

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

---

## 👥 Gestión de usuarios

Los usuarios se administran en dos pasos:

1. **Firebase Console** → Authentication → Agregar usuario (email + contraseña)
2. **App** → Panel 👥 Usuarios → Agregar ese email con su rol

---

## 📦 Deploy

El deploy es automático a través de Vercel en cada `git push` a `main`.

```bash
git add .
git commit -m "descripción del cambio"
git push
```

---

## 📊 Límites del plan gratuito

| Recurso | Límite | Uso estimado (200 torneos/mes) |
|---------|--------|-------------------------------|
| Lecturas Firestore | 50,000/día | ~3,300/día |
| Escrituras Firestore | 20,000/día | ~2,000/día |
| Almacenamiento | 1 GB | ~30 MB (3 meses) |
| Usuarios Auth | 10,000/mes | < 10 |

---

## 🔒 Seguridad

- Credenciales en variables de entorno (nunca en el código)
- Autenticación requerida para acceder a la app
- Sanitización de todos los inputs
- Reglas de Firestore restringidas a usuarios autenticados

---

*Desarrollado por **Melissa Berdeja** · Dev & Design*
