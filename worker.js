// 1. Import the HTML content
import html from './index.html';

export default {
  async fetch(request, env) {
    // Handle CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url = new URL(request.url);
    
    // 2. Handle WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocket(request, env);
    }

    // 3. Handle API endpoints (optional)
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // 4. SERVE HTML (This was missing)
    return new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    });
  },
};

// --- EXISTING LOGIC BELOW ---
async function handleWebSocket(request, env) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  server.accept();
  const gameHandler = new GameHandler(server, env);
  
  server.addEventListener('message', event => {
    gameHandler.handleMessage(event.data);
  });

  server.addEventListener('close', event => {
    gameHandler.handleDisconnect();
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

class GameHandler {
  constructor(ws, env) {
    this.ws = ws;
    this.env = env;
    this.playerId = null;
    this.gameCode = null;
  }

  async handleMessage(message) {
    try {
      const data = JSON.parse(message);
      
      switch(data.type) {
        case 'createGame': await this.createGame(data); break;
        case 'joinGame': await this.joinGame(data); break;
        case 'assignTeams': await this.assignTeams(data); break;
        case 'startGame': await this.startGame(data); break;
        case 'askForCard': await this.askForCard(data); break;
        case 'makeClaim': await this.makeClaim(data); break;
        case 'rejoin': await this.rejoinGame(data); break;
        default: this.send({ type: 'error', message: 'Unknown message type' });
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  }

  // ... [PASTE THE REST OF YOUR GAMEHANDLER CLASS METHODS HERE] ...
  // (Copy the methods createGame, joinGame, etc. from your original file. 
  // They are unchanged.) 
  
  // Helper methods
  generateGameCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
  createDeck() {
    const halfSuits = this.getHalfSuits();
    const deck = [];
    Object.values(halfSuits).forEach(suit => deck.push(...suit));
    return deck;
  }
  getHalfSuits() {
    return {
      'low-hearts': ['2♥', '3♥', '4♥', '5♥', '6♥', '7♥'],
      'high-hearts': ['9♥', '10♥', 'J♥', 'Q♥', 'K♥', 'A♥'],
      'low-diamonds': ['2♦', '3♦', '4♦', '5♦', '6♦', '7♦'],
      'high-diamonds': ['9♦', '10♦', 'J♦', 'Q♦', 'K♦', 'A♦'],
      'low-clubs': ['2♣', '3♣', '4♣', '5♣', '6♣', '7♣'],
      'high-clubs': ['9♣', '10♣', 'J♣', 'Q♣', 'K♣', 'A♣'],
      'low-spades': ['2♠', '3♠', '4♠', '5♠', '6♠', '7♠'],
      'high-spades': ['9♠', '10♠', 'J♠', 'Q♠', 'K♠', 'A♠']
    };
  }
  getPlayerView(gameState, playerName) {
    const view = { ...gameState };
    const playerHand = view.hands[playerName];
    view.hands = {};
    gameState.players.forEach(p => {
      if (p === playerName) view.hands[p] = playerHand;
      else view.hands[p] = new Array(gameState.hands[p].length);
    });
    return view;
  }
  send(data) { this.ws.send(JSON.stringify(data)); }
  sendToPlayer(playerName, data) { if (this.playerId === playerName) this.send(data); }
  broadcast(gameCode, data) { this.send(data); }
  async storeGameState(gameCode, gameState) { global.games = global.games || {}; global.games[gameCode] = gameState; }
  async getGameState(gameCode) { return global.games?.[gameCode] || null; }
  async deleteGameState(gameCode) { if (global.games) delete global.games[gameCode]; }
  handleDisconnect() { console.log('Player disconnected:', this.playerId); }
}