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

interface Client {
  id: string;
  type: "controller" | "tv";
  name?: string; // Identificador amigable para el TV
  groupId?: string; // Para identificar grupos de TVs sincronizados
}

interface PlaybackState {
  currentSong: any;
  currentIndex: number;
  isPlaying: boolean;
  playlist: any[];
  currentTime: number;
  duration: number;
  timestamp: number;
  tvId?: string; // ID del TV que envía el estado
}

const clients: Client[] = [];
let currentState: PlaybackState | null = null;
let syncEnabled = false; // Estado global de sincronización

io.on("connection", (socket) => {
  socket.on("identify", (info) => {
    const clientType = info.type;
    const clientName =
      info.name || `TV-${Math.random().toString(36).substr(2, 6)}`;

    if (!clients.find((c) => c.id === socket.id)) {
      const newClient = {
        id: socket.id,
        type: clientType,
        name: clientName,
      };
      clients.push(newClient);

      // Notificar a los controladores sobre el nuevo TV
      if (clientType === "tv") {
        const controllers = clients.filter((c) => c.type === "controller");
        controllers.forEach((controller) => {
          io.to(controller.id).emit(
            "tvListUpdate",
            clients.filter((c) => c.type === "tv")
          );
        });
      }

      // Enviar lista de TVs al nuevo controlador
      if (clientType === "controller") {
        socket.emit(
          "tvListUpdate",
          clients.filter((c) => c.type === "tv")
        );
        socket.emit("syncStatus", syncEnabled);
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

  socket.on("tvStateUpdate", (state: PlaybackState) => {
    if (syncEnabled) {
      // Propagar el estado a todos los TVs excepto al emisor
      const otherTvs = clients.filter(
        (c) => c.type === "tv" && c.id !== socket.id
      );
      otherTvs.forEach((tv) => {
        io.to(tv.id).emit("syncState", state);
      });
    }

    // Actualizar controladores
    const controllers = clients.filter((c) => c.type === "controller");
    controllers.forEach((controller) => {
      io.to(controller.id).emit("timeUpdate", {
        tvId: socket.id,
        currentTime: state.currentTime,
        duration: state.duration,
      });
    });
  });

  // Modificar el manejador de desconexión
  socket.on("disconnect", () => {
    const index = clients.findIndex((c) => c.id === socket.id);
    if (index !== -1) {
      const disconnectedClient = clients[index];
      clients.splice(index, 1);

      if (disconnectedClient.type === "tv") {
        // Actualizar lista de TVs en todos los controladores
        const controllers = clients.filter((c) => c.type === "controller");
        controllers.forEach((controller) => {
          io.to(controller.id).emit(
            "tvListUpdate",
            clients.filter((c) => c.type === "tv")
          );
          io.to(controller.id).emit("tvDisconnected", disconnectedClient.id);
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
