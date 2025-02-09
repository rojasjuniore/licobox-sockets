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
}

interface PlaybackState {
  currentSong: any;
  currentIndex: number;
  isPlaying: boolean;
  playlist: any[];
  currentTime: number;
  duration: number;
  timestamp: number;
}

const clients: Client[] = [];
let currentState: PlaybackState | null = null;

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  socket.on("identify", (info) => {
    const clientType = info.type;
    const existingClient = clients.find((c) => c.id === socket.id);

    if (!existingClient) {
      clients.push({ id: socket.id, type: clientType });
      console.log(`New ${clientType} identified:`, socket.id);

      // Si es un controlador, enviar el estado actual si existe
      if (clientType === "controller" && currentState) {
        socket.emit("currentState", currentState);
      }

      // Si es TV y hay estado actual, sincronizar
      if (clientType === "tv" && currentState) {
        socket.emit("syncRequest", currentState);
      }

      // Notificar a los controladores que un TV se conectó
      if (clientType === "tv") {
        const controllers = clients.filter(
          (client) => client.type === "controller"
        );
        controllers.forEach((controller) => {
          io.to(controller.id).emit("tvConnected");
        });
      }
    }
  });

  // Manejar comandos del controlador
  // Modificar el manejo de comandos
  socket.on("command", (command) => {
    // Actualizar el estado actual con el comando
    if (command.action === "changeSong") {
      currentState = {
        ...currentState,
        currentSong: command.currentSong,
        currentIndex: command.index,
        isPlaying: command.isPlaying,
        currentTime: command.currentTime || 0,
        timestamp: Date.now(),
      } as PlaybackState;
    } else if (
      command.action === "updatePlaylist" ||
      command.action === "forceSync"
    ) {
      currentState = {
        ...currentState,
        playlist: command.playlist,
        currentSong: command.currentSong,
        currentIndex: command.currentIndex,
        isPlaying: command.isPlaying,
        timestamp: Date.now(),
      } as PlaybackState;
    }

    // Enviar el comando a todos los TVs
    const tvClients = clients.filter((client) => client.type === "tv");
    tvClients.forEach((client) => {
      io.to(client.id).emit("command", { ...command, timestamp: Date.now() });
    });

    // Enviar actualización a otros controladores
    const otherControllers = clients.filter(
      (client) => client.type === "controller" && client.id !== socket.id
    );
    otherControllers.forEach((controller) => {
      io.to(controller.id).emit("currentState", currentState);
    });
  });

  // Modificar el manejo de actualizaciones del TV
  socket.on("tvStateUpdate", (state: PlaybackState) => {
    currentState = { ...state, timestamp: Date.now() };

    // Enviar actualizaciones de tiempo más frecuentes a los controladores
    const controllers = clients.filter(
      (client) => client.type === "controller"
    );

    if (state.currentTime !== undefined) {
      controllers.forEach((controller) => {
        io.to(controller.id).emit("timeUpdate", {
          currentTime: state.currentTime,
          duration: state.duration,
        });
      });
    }

    // Enviar actualizaciones completas de estado menos frecuentemente
    controllers.forEach((controller) => {
      io.to(controller.id).emit("currentState", currentState);
    });
  });

  // Manejar solicitud de estado actual
  socket.on("requestCurrentState", () => {
    const tvClient = clients.find((client) => client.type === "tv");
    if (tvClient) {
      io.to(tvClient.id).emit("requestCurrentState");
    } else if (currentState) {
      // Si no hay TV conectado pero tenemos un estado guardado, enviarlo
      socket.emit("currentState", currentState);
    }
  });

  // Manejar desconexión
  socket.on("disconnect", () => {
    const index = clients.findIndex((client) => client.id === socket.id);
    if (index !== -1) {
      const disconnectedClient = clients[index];
      clients.splice(index, 1);
      console.log(`${disconnectedClient.type} disconnected:`, socket.id);

      // Si se desconecta el TV, notificar a los controladores
      if (disconnectedClient.type === "tv") {
        const controllers = clients.filter(
          (client) => client.type === "controller"
        );
        controllers.forEach((controller) => {
          io.to(controller.id).emit("tvDisconnected");
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
