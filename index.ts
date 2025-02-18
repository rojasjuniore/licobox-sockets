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
    bufferLevel?: number;
    isBuffering?: boolean;
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

const INACTIVE_TIMEOUT = 60000; // 60 segundos
const HEARTBEAT_INTERVAL = 25000; // 25 segundos
const HEARTBEAT_TIMEOUT = 5000; // 5 segundos
const RECONNECTION_GRACE_PERIOD = 30000; // 30 segundos

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 30000,
  transports: ["websocket", "polling"],
  allowUpgrades: true,
  upgradeTimeout: 10000,
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

const handleClientRemoval = (client: Client, state: any) => {
  if (client.type === "tv") {
    if (currentState && client.id === currentState.tvId) {
      setTimeout(() => {
        const reconnected = clients.some((c) => c.id === client.id);
        if (!reconnected) {
          currentState = null;
          selectNewHost();
        }
      }, RECONNECTION_GRACE_PERIOD);
    }

    // Notificar a controladores
    const controllers = clients.filter((c) => c.type === "controller");
    controllers.forEach((controller) => {
      io.to(controller.id).emit("tvDisconnected", {
        tvId: client.id,
        state,
        timestamp: Date.now(),
      });
    });
  }
};

const handleSyncState = (socket: any, state: PlaybackState) => {
  const now = Date.now();
  const networkLatency = (now - state.timestamp) / 2;

  currentState = {
    ...state,
    lastUpdate: now,
    networkLatency,
    masterTimestamp: now,
  };

  // Notificar a todos los TVs excepto al emisor
  const tvs = clients.filter((c) => c.type === "tv" && c.id !== socket.id);
  tvs.forEach((tv) => {
    io.to(tv.id).emit("syncState", {
      ...currentState,
      adjustedTime: state.currentTime + networkLatency / 1000,
    });
  });

  // Notificar a los controladores
  const controllers = clients.filter((c) => c.type === "controller");
  controllers.forEach((controller) => {
    io.to(controller.id).emit("currentState", currentState);
  });
};

io.on("connection", (socket) => {
  let lastHeartbeat = Date.now();
  let heartbeatTimeout: NodeJS.Timeout;
  let heartbeatInterval: NodeJS.Timeout;

  const setupHeartbeat = () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);

    heartbeatInterval = setInterval(() => {
      const now = Date.now();

      // Verificar si el cliente sigue activo
      if (now - lastHeartbeat > INACTIVE_TIMEOUT) {
        console.warn(`Client ${socket.id} inactive, disconnecting...`);
        socket.disconnect(true);
        return;
      }

      socket.emit("ping", { timestamp: now });

      heartbeatTimeout = setTimeout(() => {
        const timeSinceLastHeartbeat = Date.now() - lastHeartbeat;
        if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT) {
          console.warn(
            `Client ${socket.id} heartbeat timeout (${timeSinceLastHeartbeat}ms), reconnecting...`
          );
          socket.disconnect(true);
        }
      }, HEARTBEAT_TIMEOUT);
    }, HEARTBEAT_INTERVAL);
  };

  socket.on("heartbeat", (data) => {
    lastHeartbeat = Date.now();
    const client = clients.find((c) => c.id === socket.id);
    if (client) {
      client.state = {
        ...client.state,
        ...data.state,
        timestamp: Date.now(),
        lastHeartbeat: Date.now(),
      };
    }

    // Responder inmediatamente con un pong
    socket.emit("pong", { timestamp: Date.now() });
  });

  // setupHeartbeat();

  socket.on("disconnect", (reason) => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);

    const index = clients.findIndex((c) => c.id === socket.id);
    if (index !== -1) {
      const disconnectedClient = clients[index];
      const clientState = { ...disconnectedClient.state };

      // No remover inmediatamente si es una desconexión temporal
      if (reason === "transport close" || reason === "ping timeout") {
        setTimeout(() => {
          const stillDisconnected = !clients.some((c) => c.id === socket.id);
          if (stillDisconnected) {
            clients.splice(index, 1);
            handleClientRemoval(disconnectedClient, clientState);
          }
        }, RECONNECTION_GRACE_PERIOD);
      } else {
        clients.splice(index, 1);
        handleClientRemoval(disconnectedClient, clientState);
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

    if (command.action === "play" || command.action === "pause") {
      // Verificar buffer antes de cambiar estado
      const targetTV = clients.find((c) => c.id === command.tvIds[0]);
      if (targetTV?.state?.isBuffering && targetTV?.state?.bufferLevel! < 0.1) {
        socket.emit("error", {
          message: "Buffer insuficiente para reproducir",
          timestamp: now,
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
