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
    lastBufferUpdate?: number;
    lastError?: any;
    lastErrorTimestamp?: number;
    lastHeartbeat?: any;
    bufferLevel?: number;
    isBuffering?: boolean;
    connectionStatus?: any;
    lastDisconnect?: any;
    lastReconnect?: any;
  };
}

// Mejorar la interfaz de estado
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
  lastUpdate: number;
  bufferLevel: number;
  isBuffering: boolean;
  networkLatency: number;
  masterTimestamp?: number;
  adjustedTime?: number;
}

interface SyncState extends PlaybackState {
  masterTimestamp: number;
  networkLatency: number;
}

const RECONNECTION_GRACE_PERIOD = 60000; // 60 segundos

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 20000,
  pingInterval: 10000,
  transports: ["websocket"],
  allowUpgrades: false,
  maxHttpBufferSize: 1e8,
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
    const timestamp = Date.now();
    client.state = {
      ...client.state,
      lastError: error,
      lastErrorTimestamp: timestamp,
    };

    socket.emit("error", {
      message: "An error occurred",
      timestamp,
      reconnect: true,
    });

    // Intentar resincronizar si es un TV
    if (client.type === "tv" && currentState) {
      socket.emit("syncState", {
        ...currentState,
        timestamp,
        forceSync: true,
      });
    }
  }
};

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  socket.on("identify", (info) => {
    const clientType = info.type;
    const clientName =
      info.name || `TV-${Math.random().toString(36).substr(2, 6)}`;

    // Actualizar o crear cliente
    const existingIndex = clients.findIndex((c) => c.id === socket.id);
    if (existingIndex !== -1) {
      clients[existingIndex] = {
        ...clients[existingIndex],
        id: socket.id,
        type: clientType,
        name: clientName,
        state: {
          ...info.state,
          timestamp: Date.now(),
        },
      };
    } else {
      clients.push({
        id: socket.id,
        type: clientType,
        name: clientName,
        state: {
          ...info.state,
          timestamp: Date.now(),
        },
      });
    }

    // Notificar lista de TVs actualizada
    const tvList = clients
      .filter((c) => c.type === "tv")
      .map((tv) => ({
        id: tv.id,
        name: tv.name,
        state: tv.state,
        isHost: tv.isHost,
      }));

    io.emit("tvListUpdate", tvList);
  });

  socket.on("disconnect", () => {
    const index = clients.findIndex((c) => c.id === socket.id);
    if (index !== -1) {
      const client = clients[index];
      clients.splice(index, 1);

      // Notificar desconexión si era un TV
      if (client.type === "tv") {
        io.emit(
          "tvListUpdate",
          clients
            .filter((c) => c.type === "tv")
            .map((tv) => ({
              id: tv.id,
              name: tv.name,
              state: tv.state,
              isHost: tv.isHost,
            }))
        );
      }
    }
  });

  socket.on("bufferState", (data: any) => {
    const client = clients.find((c) => c.id === data.tvId);
    if (client) {
      // Actualizar estado del cliente
      client.state = {
        ...client.state,
        isBuffering: data.isBuffering,
        bufferLevel: data.bufferLevel,
        timestamp: Date.now(),
        lastBufferUpdate: Date.now(),
      };

      // Si el buffer está muy bajo, solicitar estado actualizado
      if (data.bufferLevel < 0.1) {
        // 10%
        const existingTVs = clients.filter(
          (c) =>
            c.type === "tv" &&
            c.id !== data.tvId &&
            (c.state?.bufferLevel || 0) > 0.5
        );

        if (existingTVs.length > 0) {
          // Solicitar estado a un TV con buen buffer
          io.to(existingTVs[0].id).emit("requestFullState", {
            targetTvId: data.tvId,
            timestamp: Date.now(),
          });
        }
      }

      // Notificar a controladores
      const controllers = clients.filter((c) => c.type === "controller");
      controllers.forEach((controller) => {
        io.to(controller.id).emit("bufferUpdate", {
          ...data,
          timestamp: Date.now(),
        });
      });
    }
  });

  // En el manejador de 'identify'
  socket.on("identify", (info) => {
    const clientType = info.type;
    const clientName =
      info.name || `TV-${Math.random().toString(36).substr(2, 6)}`;

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
        // Encontrar un TV existente para obtener el estado actual
        const existingTV = clients.find(
          (c) => c.type === "tv" && c.id !== socket.id
        );
        if (existingTV) {
          io.to(existingTV.id).emit("requestFullState");
        }
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

  socket.on("command", (command) => {
    const now = Date.now();
    console.log("Received command:", command);

    // Obtener los TVs objetivo
    const targetTvIds = command.tvIds ||
      clients.filter((c) => c.type === "tv").map((tv) => tv.id);

    // Verificar buffer solo para comandos de reproducción
    if (command.action === "play" && command.tvIds?.length > 0) {
      const targetTV = clients.find((c) => c.id === command.tvIds[0]);
      if (targetTV?.state?.isBuffering && targetTV?.state?.bufferLevel! < 0.1) {
        socket.emit("error", {
          message: "Buffer insuficiente para reproducir",
          timestamp: now,
        });
        return;
      }
    }

    // Enviar comando a los TVs
    targetTvIds.forEach((tvId: any) => {
      console.log(`Sending ${command.action} command to TV ${tvId}`);
      io.to(tvId).emit("command", {
        ...command,
        timestamp: now,
        synchronized: syncEnabled || command.action === "forceSync",
      });
    });

    // Actualizar el estado actual y notificar a todos los controladores
    if (command.action === "play" || command.action === "pause") {
      const isPlaying = command.action === "play";
      
      // Actualizar estado global
      currentState = {
        ...currentState,
        isPlaying,
        timestamp: now,
      } as PlaybackState;

      // Actualizar estado de los TVs afectados
      targetTvIds.forEach((tvId: string) => {
        const client = clients.find((c) => c.id === tvId);
        if (client) {
          client.state = {
            ...client.state,
            isPlaying,
            timestamp: now,
          };
        }
      });

      // Notificar a TODOS los controladores, incluyendo el que envió el comando
      const allControllers = clients.filter((c) => c.type === "controller");
      allControllers.forEach((controller) => {
        io.to(controller.id).emit("currentState", {
          ...currentState,
          tvIds: targetTvIds,
          isPlaying, // Asegurar que este campo se envía
          action: command.action, // Agregar el tipo de acción
          timestamp: now,
        });
      });
    }
  });

  // Nuevo handler para sincronización de estado
  socket.on("syncState", (state: PlaybackState) => {
    const now = Date.now();
    const networkLatency = (now - state.timestamp) / 2;

    currentState = {
      ...state,
      timestamp: now,
      networkLatency,
      adjustedTime: state.currentTime + networkLatency / 1000,
    };

    // Propagar a otros TVs con el tiempo ajustado
    const tvs = clients.filter((c) => c.type === "tv" && c.id !== socket.id);
    tvs.forEach((tv) => {
      io.to(tv.id).emit("syncState", {
        ...currentState,
        adjustedTime: currentState?.adjustedTime,
      });
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
          lastStateUpdate: timestamp,
        };

        // Propagar el estado a los controladores
        const controllers = clients.filter((c) => c.type === "controller");
        controllers.forEach((controller) => {
          io.to(controller.id).emit("currentState", {
            ...state,
            timestamp: stateTimestamp,
            isHost: client.isHost,
            stateSequence: currentState?.stateSequence,
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

  socket.on("fullStateUpdate", (state) => {
    // Actualizar el estado del TV en la lista de clientes
    const tvIndex = clients.findIndex((c) => c.id === state.tvId);
    if (tvIndex !== -1) {
      clients[tvIndex].state = state.state;
    }

    // Notificar a los controladores
    const controllers = clients.filter((c) => c.type === "controller");
    controllers.forEach((controller) => {
      io.to(controller.id).emit("tvStateUpdate", state);
    });
  });

  socket.on("syncConfirm", (data) => {
    const controllers = clients.filter((c) => c.type === "controller");
    controllers.forEach((controller) => {
      io.to(controller.id).emit("tvSyncConfirmed", data);
    });
  });

  socket.on("reconnect", async (attemptNumber) => {
    const client = clients.find((c) => c.id === socket.id);
    if (client?.type === "tv") {
      // Solicitar estado actualizado al host
      const hostTV = clients.find((c) => c.isHost);
      if (hostTV) {
        io.to(hostTV.id).emit("requestFullState", {
          targetTvId: socket.id,
          timestamp: Date.now(),
        });
      }
    }
  });

  socket.on("reconnect_attempt", (attemptNumber) => {
    console.log(
      `Reconnection attempt ${attemptNumber} for client ${socket.id}`
    );

    // Si es un TV intentando reconectar
    const previousState =
      currentState?.tvId === socket.id ? currentState : null;

    if (previousState) {
      socket.emit("restoreState", {
        ...previousState,
        timestamp: Date.now(),
        forceRestore: true,
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
