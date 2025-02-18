import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

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
    lastStateReceived?: number;
  };
}

interface PlayedSong {
  id: string;
  title: string;
  artist: string;
  timestamp: number;
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
  stateSequence: number;
}

interface SyncState extends PlaybackState {
  masterTimestamp: number;
  networkLatency: number;
}

const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 5000;

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
    allowedHeaders: ["*"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
  allowEIO3: true,
  connectTimeout: 45000,
});

const clients: Client[] = [];
let currentState: PlaybackState | null = null;
let syncEnabled = false;
let hostTvId: string | null = null; // Para trackear el TV host actual

// Agregar al inicio después de las constantes
const handleError = (socket: any, error: any) => {
  console.error(`Error for client ${socket.id}:`, error);

  const client = clients.find((c) => c.id === socket.id);
  if (client) {
    // Notificar al cliente del error
    socket.emit("error", {
      message: "An error occurred",
      timestamp: Date.now(),
    });

    // Si es un TV, intentar resincronizar
    if (client.type === "tv" && currentState) {
      socket.emit("syncState", {
        ...currentState,
        timestamp: Date.now(),
        forceSync: true,
      });
    }
  }
};

// Agregar al inicio del archivo después de las interfaces
const selectNewHost = () => {
  const tvs = clients.filter((c) => c.type === "tv");
  if (tvs.length > 0) {
    const newHost = tvs[0];
    hostTvId = newHost.id;
    newHost.isHost = true;

    // Notificar a todos los clientes
    io.emit("hostUpdate", { hostId: newHost.id });
    return newHost;
  }
  return null;
};

io.on("connection", (socket) => {
  let lastHeartbeat = Date.now();

  const heartbeatInterval = setInterval(() => {
    if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT) {
      console.warn(`Client ${socket.id} heartbeat timeout`);
      socket.disconnect(true);
    } else {
      socket.emit("ping");
    }
  }, HEARTBEAT_INTERVAL);

  socket.on("pong", () => {
    lastHeartbeat = Date.now();
  });

  socket.on("heartbeat", (data) => {
    lastHeartbeat = Date.now();
    const client = clients.find((c) => c.id === socket.id);
    if (client) {
      client.state = {
        ...client.state,
        ...data.state,
        timestamp: Date.now(),
      };
    }
  });

  // Modificar el evento disconnect
  socket.on("disconnect", () => {
    clearInterval(heartbeatInterval);
  
    const index = clients.findIndex((c) => c.id === socket.id);
    if (index !== -1) {
      const disconnectedClient = clients[index];
      
      // Remover inmediatamente el cliente
      clients.splice(index, 1);
  
      if (disconnectedClient.type === "tv") {
        // Notificar a todos los controladores
        const controllers = clients.filter((c) => c.type === "controller");
        controllers.forEach((controller) => {
          io.to(controller.id).emit("tvDisconnected", {
            tvId: disconnectedClient.id,
          });
        });
  
        // Actualizar lista de TVs
        const tvList = clients
          .filter((c) => c.type === "tv")
          .map((tv) => ({
            id: tv.id,
            name: tv.name,
            state: tv.state,
            isHost: tv.isHost || false,
          }));
  
        controllers.forEach((controller) => {
          io.to(controller.id).emit("tvListUpdate", tvList);
        });
  
        // Si el host se desconecta, seleccionar uno nuevo
        if (disconnectedClient.id === hostTvId) {
          hostTvId = null;
          const newHost = selectNewHost();
          if (newHost) {
            io.emit("hostUpdate", { hostId: newHost.id });
          }
        }
      }
    }
  });
  // Modificar el evento identify
  socket.on("identify", (info) => {
    const clientType = info.type;
    const clientName = info.name || `TV-${Math.random().toString(36).substr(2, 6)}`;
  
    // Remover cualquier cliente existente con el mismo ID
    const existingIndex = clients.findIndex((c) => c.id === socket.id);
    if (existingIndex !== -1) {
      clients.splice(existingIndex, 1);
    }
  
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
  
    // Enviar lista de TVs cuando se conecta un TV o un controlador
    if (clientType === "tv" || clientType === "controller") {
      const tvList = clients
        .filter((c) => c.type === "tv")
        .map((tv) => ({
          id: tv.id,
          name: tv.name,
          state: tv.state,
          isHost: tv.isHost || false,
        }));
  
      // Si es un TV, notificar a todos los controladores
      if (clientType === "tv") {
        const controllers = clients.filter((c) => c.type === "controller");
        controllers.forEach((controller) => {
          io.to(controller.id).emit("tvListUpdate", tvList);
        });
      }
  
      // Si es un TV y no hay host, seleccionarlo como host
      if (clientType === "tv" && !hostTvId) {
        const newClient = clients[clients.length - 1];
        hostTvId = newClient.id;
        newClient.isHost = true;
        io.emit("hostUpdate", { hostId: newClient.id });
      }
  
      // Si es un controlador, enviar la lista actual solo a este controlador
      else if (clientType === "controller") {
        io.to(socket.id).emit("tvListUpdate", tvList);
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
  // Modificar el handler de command
  socket.on("command", (command) => {
    if (command.action === "play" || command.action === "pause") {
      if (currentState) {
        currentState.isPlaying = command.action === "play";
        currentState.timestamp = Date.now();
      }
  
      // Asegurarse de que el comando llegue a todos los TVs afectados
      const targetTvIds = command.tvIds || 
        clients.filter((c) => c.type === "tv").map((tv) => tv.id);
  
      const playbackState = {
        isPlaying: command.action === "play",
        timestamp: Date.now(),
        forceUpdate: true, // Forzar actualización
        sourceId: socket.id // Identificar la fuente del comando
      };
  
      // Emitir a TVs
      targetTvIds.forEach((tvId: string) => {
        io.to(tvId).emit("playbackUpdate", playbackState);
      });
  
      // Notificar a todos los controladores
      const controllers = clients.filter((c) => c.type === "controller");
      controllers.forEach((controller) => {
        io.to(controller.id).emit("playbackUpdate", playbackState);
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
      const currentTimestamp = Date.now();
      const networkLatency = (currentTimestamp - state.masterTimestamp) / 2;

      const slaves = clients.filter(
        (c) => c.type === "tv" && c.id !== hostTvId
      );
      slaves.forEach((slave) => {
        io.to(slave.id).emit("slaveSyncUpdate", {
          ...state,
          masterTimestamp: currentTimestamp,
          networkLatency,
          adjustedTime: state.currentTime + networkLatency / 1000,
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

  socket.on("stateReceived", (data: { tvId: string; timestamp: number }) => {
    const tv = clients.find((c) => c.id === data.tvId);
    if (tv) {
      tv.state = {
        ...tv.state,
        lastStateReceived: data.timestamp,
      };
    }
  });

  // Modificar el handler de tvStateUpdate
  socket.on("tvStateUpdate", (state) => {
    const client = clients.find((c) => c.id === state.tvId);
    if (client) {
      const timestamp = Date.now();
      const stateTimestamp = state.state?.timestamp || timestamp;

      // Validar el estado de reproducción
      if (state.state?.isPlaying !== undefined) {
        client.state = {
          ...client.state,
          ...state.state,
          timestamp: stateTimestamp,
          lastStateUpdate: timestamp
        };
  
        // Propagar el estado a los controladores
        const controllers = clients.filter((c) => c.type === "controller");
        controllers.forEach((controller) => {
          io.to(controller.id).emit("currentState", {
            ...state,
            timestamp: stateTimestamp,
            isHost: client.isHost,
            stateSequence: currentState?.stateSequence
          });
        });
      }
    }
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

  socket.on("songCompleted", async (data) => {
    // Store the played song and notify controllers
    const controllers = clients.filter((c) => c.type === "controller");
    controllers.forEach((controller) => {
      io.to(controller.id).emit("songCompleted", {
        tvId: data.tvId,
        song: data.song,
        playedSongs: data.playedSongs,
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

  socket.on("reconnect_attempt", (attemptNumber) => {
    console.log(
      `Client ${socket.id} attempting to reconnect (attempt ${attemptNumber})`
    );
    const client = clients.find((c) => c.id === socket.id);
    if (client?.type === "tv" && currentState) {
      socket.emit("syncState", {
        ...currentState,
        timestamp: Date.now(),
        forceSync: true,
      });
    }
  });

  socket.on("error", (error) => handleError(socket, error));

  socket.on("connect_error", (error) => {
    console.error(`Connection error for ${socket.id}:`, error);
    handleError(socket, error);
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

setInterval(() => {
  const now = Date.now();
  const inactiveTimeout = 60000; // 1 minuto

  clients.forEach((client) => {
    if (
      client.state?.timestamp &&
      now - client.state.timestamp > inactiveTimeout
    ) {
      const socket = io.sockets.sockets.get(client.id);
      if (socket) {
        console.log(`Disconnecting inactive client ${client.id}`);
        socket.disconnect(true);
      }
    }
  });
}, 30000);
