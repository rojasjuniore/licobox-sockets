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

  // Manejar la identificación del cliente
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
        const controllers = clients.filter(client => client.type === "controller");
        controllers.forEach(controller => {
          io.to(controller.id).emit("tvConnected");
        });
      }
    }
  });

  // Manejar actualización de estado del TV
  socket.on("tvStateUpdate", (state: PlaybackState) => {
    currentState = state;
    const controllers = clients.filter(client => client.type === "controller");
    controllers.forEach(controller => {
      io.to(controller.id).emit("currentState", state);
    });
  });

  // Manejar comandos del controlador
  socket.on("command", (command) => {
    const tvClients = clients.filter(client => client.type === "tv");
    tvClients.forEach(client => {
      io.to(client.id).emit("command", command);
    });
  });

  // Manejar solicitud de estado actual
  socket.on("requestCurrentState", () => {
    const tvClient = clients.find(client => client.type === "tv");
    if (tvClient) {
      io.to(tvClient.id).emit("requestCurrentState");
    }
  });

  // Manejar desconexión
  socket.on("disconnect", () => {
    const index = clients.findIndex(client => client.id === socket.id);
    if (index !== -1) {
      const disconnectedClient = clients[index];
      clients.splice(index, 1);
      console.log(`${disconnectedClient.type} disconnected:`, socket.id);

      // Si se desconecta el TV, notificar a los controladores
      if (disconnectedClient.type === "tv") {
        const controllers = clients.filter(client => client.type === "controller");
        controllers.forEach(controller => {
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
