import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: [
      "http://localhost:4200",
      "http://localhost:3001",
      "http://localhost:5173",
      "https://licobox-sockets-production.up.railway.app",
      "https://licobox-sockets-production.up.railway.app:6533",
    ],
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: [],
  },
});

// Update the Client interface to include timestamp
interface Client {
  id: string;
  type: "controller" | "tv";
  name?: string;
  isHost?: boolean;
  state?: {
    currentTime?: number;
    duration?: number;
    isPlaying?: boolean;
    playlist?: any[];
    currentSong?: number;
    timestamp?: number; // Add this line
  };
}

interface PlaybackState {
  currentSong: any;
  currentIndex: number;
  isPlaying: boolean;
  playlist: any[];
  currentTime: number;
  duration: number;
  timestamp: number;
  tvId?: string;
  bufferState?: number;
}

interface SyncState extends PlaybackState {
  masterTimestamp: number;
  networkLatency: number;
}

const clients: Client[] = [];
let currentState: PlaybackState | null = null;
let syncEnabled = false;
let hostTvId: string | null = null; // Para trackear el TV host actual

// Función para seleccionar un nuevo host
const selectNewHost = () => {
  const tvs = clients.filter((c) => c.type === "tv");
  if (tvs.length > 0) {
    const newHost = tvs[0];
    hostTvId = newHost.id;
    newHost.isHost = true;
    io.to(newHost.id).emit("becomeHost", true);
    return newHost;
  }
  return null;
};

const safeEmit = (socket: any, event: string, data: any) => {
  try {
    socket.emit(event, data);
  } catch (error) {
    console.error(`Error emitting ${event}:`, error);
  }
};

io.on("connection", (socket) => {
  // Modificar el evento identify
  socket.on("identify", (info) => {
    const clientType = info.type;
    const clientName =
      info.name || `TV-${Math.random().toString(36).substr(2, 6)}`;

    const existingClient = clients.find((c) => c.id === socket.id);
    if (!existingClient) {
      const newClient: Client = {
        id: socket.id,
        type: clientType,
        name: clientName,
        state: {
          ...info.state,
          timestamp: Date.now(),
        },
      };
      clients.push(newClient);

      // Solo enviar actualización de lista cuando se conecta/desconecta un TV
      if (clientType === "tv") {
        const tvList = clients
          .filter((c) => c.type === "tv")
          .map((tv) => ({
            id: tv.id,
            name: tv.name,
            state: tv.state,
            isHost: tv.isHost || false,
          }));

        const controllers = clients.filter((c) => c.type === "controller");
        controllers.forEach((controller) => {
          io.to(controller.id).emit("tvListUpdate", tvList);
        });
      }
    }
  });

  // Nuevo manejador para toggle de sincronización
  socket.on("toggleSync", (enabled: boolean) => {
    syncEnabled = enabled;
    // Notificar a todos los controladores
    const controllers = clients.filter((c) => c.type === "controller");
    controllers.forEach((controller) => {
      io.to(controller.id).emit("syncStatus", syncEnabled);
    });
  });

  // Eliminar el segundo manejador de command y unificar la lógica
  socket.on("command", (command) => {
    if (command.action === "play" || command.action === "pause") {
      if (currentState) {
        currentState.isPlaying = command.action === "play";
        currentState.timestamp = Date.now();
      }

      // Emitir un evento específico para cambios de reproducción
      const targetTvIds =
        command.tvIds ||
        clients.filter((c) => c.type === "tv").map((tv) => tv.id);

      targetTvIds.forEach((tvId: string) => {
        io.to(tvId).emit("playbackUpdate", {
          isPlaying: command.action === "play",
          timestamp: Date.now(),
        });
      });

      // Notificar a los controladores con un evento específico
      const controllers = clients.filter((c) => c.type === "controller");
      controllers.forEach((controller) => {
        io.to(controller.id).emit("playbackUpdate", {
          isPlaying: command.action === "play",
          timestamp: Date.now(),
        });
      });
      return;
    }

    const targetTvIds =
      command.tvIds ||
      clients.filter((c) => c.type === "tv").map((tv) => tv.id);

    if (
      command.action === "changeSong" ||
      command.action === "updatePlaylist" ||
      command.action === "forceSync"
    ) {
      currentState = {
        ...currentState,
        ...command,
        timestamp: Date.now(),
      } as PlaybackState;
    }

    // Si la sincronización está activada o es un comando de sincronización forzada
    if (syncEnabled || command.action === "forceSync") {
      // Enviar a todos los TVs
      targetTvIds.forEach((tvId: any) => {
        io.to(tvId).emit("command", {
          ...command,
          timestamp: Date.now(),
          synchronized: true,
        });
      });
    } else {
      // Enviar solo a los TVs especificados
      targetTvIds.forEach((tvId: any) => {
        io.to(tvId).emit("command", {
          ...command,
          timestamp: Date.now(),
        });
      });
    }

    // Actualizar otros controladores
    const otherControllers = clients.filter(
      (c) => c.type === "controller" && c.id !== socket.id
    );
    otherControllers.forEach((controller) => {
      io.to(controller.id).emit("currentState", {
        ...currentState,
        tvIds: targetTvIds,
      });
    });
  });

  // Optimizar el manejo de desconexión
  socket.on("disconnect", () => {
    const index = clients.findIndex((c) => c.id === socket.id);
    if (index !== -1) {
      const disconnectedClient = clients[index];
      clients.splice(index, 1);
  
      // Solo notificar cambios en la lista de TVs si el cliente desconectado era un TV
      if (disconnectedClient.type === "tv") {
        const tvList = clients
          .filter((c) => c.type === "tv")
          .map((tv) => ({
            id: tv.id,
            name: tv.name,
            state: tv.state,
            isHost: tv.isHost || false,
          }));
  
        const controllers = clients.filter((c) => c.type === "controller");
        controllers.forEach((controller) => {
          io.to(controller.id).emit("tvListUpdate", tvList);
        });
      }
  
      // Manejar cambio de host si es necesario
      if (disconnectedClient.type === "tv" && disconnectedClient.isHost) {
        const newHost = selectNewHost();
        if (newHost) {
          io.emit("hostUpdate", { hostId: newHost.id });
        }
      }
    }
  });

  // Nuevo handler para sincronización de estado
  socket.on("syncState", (state: PlaybackState) => {
    currentState = { ...state, timestamp: Date.now() };

    // Propagar el estado a todos los TVs excepto al emisor
    const tvs = clients.filter((c) => c.type === "tv" && c.id !== socket.id);
    tvs.forEach((tv) => {
      io.to(tv.id).emit("syncState", currentState);
    });

    // Informar a los controladores
    const controllers = clients.filter((c) => c.type === "controller");
    controllers.forEach((controller) => {
      io.to(controller.id).emit("currentState", currentState);
    });
  });

  socket.on("masterSync", (state: SyncState) => {
    if (hostTvId === socket.id) {
      const slaves = clients.filter(
        (c) => c.type === "tv" && c.id !== hostTvId
      );
      slaves.forEach((slave) => {
        io.to(slave.id).emit("slaveSyncUpdate", {
          ...state,
          masterTimestamp: Date.now(),
        });
      });

      // Informar a los controladores
      const controllers = clients.filter((c) => c.type === "controller");
      controllers.forEach((controller) => {
        io.to(controller.id).emit("timeUpdate", {
          tvId: socket.id,
          currentTime: state.currentTime,
          duration: state.duration,
          isPlaying: state.isPlaying,
        });
      });
    }
  });

  // Añadir nuevo handler para solicitud de estado
  socket.on("requestTVState", (data: any) => {
    const targetTv = clients.find((c) => c.id === data.tvId);
    if (targetTv) {
      io.to(data.tvId).emit("getState");
    }
  });

  // Modificar el handler de playlistUpdate
  socket.on("playlistUpdate", (data: any) => {
    const targetTvIds = data.isSyncMode
      ? clients.filter((c) => c.type === "tv").map((tv) => tv.id)
      : [data.tvId];

    // Actualizar el estado actual
    currentState = {
      ...currentState,
      playlist: data.playlist,
      currentIndex: data.currentSong,
    } as PlaybackState;

    targetTvIds.forEach((tvId) => {
      io.to(tvId).emit("playlistUpdate", {
        playlist: data.playlist,
        currentSong: data.currentSong,
        tvId: data.tvId,
        isSyncMode: data.isSyncMode,
      });
    });

    // Actualizar todos los controladores
    const controllers = clients.filter((c) => c.type === "controller");
    controllers.forEach((controller) => {
      io.to(controller.id).emit("playlistUpdate", {
        playlist: data.playlist,
        currentSong: data.currentSong,
        tvId: data.tvId,
        isSyncMode: data.isSyncMode,
      });
    });
  });

  // Modificar el handler de tvStateUpdate
  socket.on("tvStateUpdate", (state) => {
    // Validar que state y state.state existan
    if (!state || !state.state) {
      console.error("Invalid state object received:", state);
      return;
    }

    const tvClient = clients.find((c) => c.id === state.tvId || socket.id);
    if (tvClient) {
      // Update state with proper typing and default values
      tvClient.state = {
        currentTime: state.state.currentTime || 0,
        duration: state.state.duration || 0,
        isPlaying: state.state.isPlaying || false,
        playlist: state.state.playlist || [],
        currentSong: state.state.currentSong || 0,
        timestamp: Date.now(),
      };

      // Update global state if host
      if (tvClient.isHost && currentState) {
        currentState = {
          ...currentState,
          currentTime: state.state.currentTime || 0,
          duration: state.state.duration || 0,
          isPlaying: state.state.isPlaying || false,
          playlist: state.state.playlist || [],
          currentIndex: state.state.currentSong || 0,
          timestamp: Date.now(),
        };
      }
    }

    // Enviar solo actualización de estado sin actualizar la lista completa de TVs
    const controllers = clients.filter((c) => c.type === "controller");
    controllers.forEach((controller) => {
      safeEmit(io.to(controller.id), "tvStateUpdate", {
        tvId: state.tvId || socket.id,
        state: {
          currentTime: state.state.currentTime || 0,
          duration: state.state.duration || 0,
          isPlaying: state.state.isPlaying || false,
          playlist: state.state.playlist || [],
          currentSong: state.state.currentSong || 0,
          timestamp: Date.now(),
        },
      });
    });
  });

  socket.on("seek", (data: any) => {
    const targetTvIds = data.isSyncMode
      ? clients.filter((c) => c.type === "tv").map((tv) => tv.id)
      : [data.tvId];

    targetTvIds.forEach((tvId) => {
      io.to(tvId).emit("seek", {
        time: data.time,
        tvId: data.tvId,
        isSyncMode: data.isSyncMode,
        timestamp: Date.now(),
      });
    });
  });

  socket.on("reconnect", (attemptNumber) => {
    // Restaurar estado del cliente
    const client = clients.find((c) => c.id === socket.id);
    if (client) {
      socket.emit("restoreState", currentState);
    }
  });

  // Mejorar el manejo de errores
  socket.on("error", (error) => {
    console.error("Socket error:", error);
    // Notificar a los clientes afectados
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});

setInterval(() => {
  clients.forEach((client) => {
    io.to(client.id).emit("ping");
  });
}, 30000);
