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
      "https://licobox-sockets-production.up.railway.app", // Agregamos el dominio de producción
      "https://licobox-sockets-production.up.railway.app:6533", // También el puerto seguro
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

const clients: Client[] = [];

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  socket.on("requestCurrentState", () => {
    const tvClient = clients.find((client) => client.type === "tv");
    if (tvClient) {
      io.to(tvClient.id).emit("requestCurrentState");
    }
  });

  socket.on("identify", (info) => {
    const clientType = info.type;
    const existingClient = clients.find((c) => c.id === socket.id);

    if (!existingClient) {
      clients.push({ id: socket.id, type: clientType });

      if (clientType === "controller") {
        const tvClient = clients.find((client) => client.type === "tv");
        if (tvClient) {
          // Solicitar estado actual al TV y esperar respuesta
          io.to(tvClient.id).emit("requestCurrentState");
        }
      }

      if (clientType === "tv") {
        // Asegurarse de que el TV envíe su estado completo
        socket.emit("requestCurrentState");
        clients
          .filter((client) => client.type === "controller")
          .forEach((controller) => {
            io.to(controller.id).emit("clientConnected", { type: "tv" });
          });
      }
    }
  });

  // Modificar el manejo de playbackStatus para incluir toda la información necesaria
  socket.on("playbackStatus", (status) => {
    const controllerClients = clients.filter(
      (client) => client.type === "controller"
    );
    // Asegurarse de que el estado incluya toda la información necesaria
    const fullStatus = {
      ...status,
      currentIndex: status.currentIndex || 0,
      playlist: status.playlist || [],
      timestamp: Date.now(),
    };

    controllerClients.forEach((client) => {
      io.to(client.id).emit("playbackStatus", fullStatus);
    });
  });

  // Manejar comandos del controlador al TV
  socket.on("command", (command) => {
    const tvClients = clients.filter((client) => client.type === "tv");
    tvClients.forEach((client) => {
      io.to(client.id).emit("command", command);
    });
  });

  // Manejar estado del controlador
  socket.on("controllerState", (state) => {
    const tvClients = clients.filter((client) => client.type === "tv");
    tvClients.forEach((client) => {
      io.to(client.id).emit("controllerState", state);
    });
  });

  // Manejar estado de reproducción del TV
  socket.on("playbackStatus", (status) => {
    const controllerClients = clients.filter(
      (client) => client.type === "controller"
    );
    controllerClients.forEach((client) => {
      io.to(client.id).emit("playbackStatus", status);
    });
  });

  // Cuando el TV envía su estado actual
  socket.on("currentTVState", (state) => {
    const controllerClients = clients.filter(
      (client) => client.type === "controller"
    );
    controllerClients.forEach((client) => {
      io.to(client.id).emit("currentState", state);
    });
  });

  // Manejar desconexión con notificación
  socket.on("disconnect", () => {
    const index = clients.findIndex((client) => client.id === socket.id);
    if (index !== -1) {
      const disconnectedClient = clients[index];
      clients.splice(index, 1);
      console.log(`${disconnectedClient.type} client disconnected:`, socket.id);

      // Notificar a los clientes restantes sobre la desconexión
      if (disconnectedClient.type === "tv") {
        const controllerClients = clients.filter(
          (client) => client.type === "controller"
        );
        controllerClients.forEach((client) => {
          io.to(client.id).emit("tvDisconnected");
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
