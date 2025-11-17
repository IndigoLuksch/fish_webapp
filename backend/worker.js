// Cloudflare Worker for Fish Game Multiplayer Backend
// Deploy this as a Cloudflare Worker to enable real-time multiplayer

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
    
    // WebSocket upgrade for real-time communication
    if (request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocket(request, env);
    }

    // HTTP endpoints for game state
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return new Response('Fish Game API', { 
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  },
};

async function handleWebSocket(request, env) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  server.accept();
  
  // Initialize game handler for this connection
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
        case 'createGame':
          await this.createGame(data);
          break;
        case 'joinGame':
          await this.joinGame(data);
          break;
        case 'assignTeams':
          await this.assignTeams(data);
          break;
        case 'startGame':
          await this.startGame(data);
          break;
        case 'askForCard':
          await this.askForCard(data);
          break;
        case 'makeClaim':
          await this.makeClaim(data);
          break;
        case 'rejoin':
          await this.rejoinGame(data);
          break;
        default:
          this.send({ type: 'error', message: 'Unknown message type' });
      }
    } catch (error) {
      console.error('Error handling message:', error);
      this.send({ type: 'error', message: 'Failed to process request' });
    }
  }

  async createGame(data) {
    const gameCode = this.generateGameCode();
    const gameState = {
      code: gameCode,
      players: [data.playerName],
      teams: { team1: [], team2: [] },
      hands: {},
      currentTurn: 0,
      claimedSuits: { team1: [], team2: [] },
      host: data.playerName,
      started: false,
      created: Date.now(),
    };

    // Store in Durable Object or KV
    await this.storeGameState(gameCode, gameState);
    
    this.playerId = data.playerName;
    this.gameCode = gameCode;
    
    this.send({
      type: 'gameCreated',
      gameCode: gameCode,
      playerName: data.playerName,
    });
  }

  async joinGame(data) {
    const gameState = await this.getGameState(data.gameCode);
    
    if (!gameState) {
      this.send({ type: 'error', message: 'Game not found' });
      return;
    }

    if (gameState.players.includes(data.playerName)) {
      this.send({ type: 'error', message: 'Name already taken' });
      return;
    }

    if (gameState.players.length >= 12) {
      this.send({ type: 'error', message: 'Game is full' });
      return;
    }

    gameState.players.push(data.playerName);
    await this.storeGameState(data.gameCode, gameState);
    
    this.playerId = data.playerName;
    this.gameCode = data.gameCode;
    
    // Broadcast to all players
    this.broadcast(data.gameCode, {
      type: 'playerJoined',
      playerName: data.playerName,
      players: gameState.players,
    });
  }

  async assignTeams(data) {
    const gameState = await this.getGameState(data.gameCode);
    
    if (!gameState) return;
    
    if (gameState.players.length < 4) {
      this.send({ type: 'error', message: 'Need at least 4 players' });
      return;
    }

    let players = [...gameState.players];
    if (data.random) {
      players.sort(() => Math.random() - 0.5);
    }

    gameState.teams.team1 = players.filter((_, i) => i % 2 === 0);
    gameState.teams.team2 = players.filter((_, i) => i % 2 === 1);
    
    await this.storeGameState(data.gameCode, gameState);
    
    this.broadcast(data.gameCode, {
      type: 'teamsAssigned',
      teams: gameState.teams,
    });
  }

  async startGame(data) {
    const gameState = await this.getGameState(data.gameCode);
    
    if (!gameState || gameState.started) return;
    
    // Create and shuffle deck
    const deck = this.createDeck();
    deck.sort(() => Math.random() - 0.5);
    
    // Deal cards
    const cardsPerPlayer = Math.floor(deck.length / gameState.players.length);
    gameState.players.forEach((player, i) => {
      gameState.hands[player] = deck.slice(
        i * cardsPerPlayer,
        (i + 1) * cardsPerPlayer
      );
    });
    
    gameState.currentTurn = 0;
    gameState.started = true;
    
    await this.storeGameState(data.gameCode, gameState);
    
    // Send personalized game state to each player
    gameState.players.forEach(player => {
      this.sendToPlayer(player, {
        type: 'gameStarted',
        gameState: this.getPlayerView(gameState, player),
      });
    });
  }

  async askForCard(data) {
    const gameState = await this.getGameState(data.gameCode);
    if (!gameState) return;

    const asker = gameState.players[gameState.currentTurn];
    const target = data.target;
    const card = data.card;

    // Validate the ask
    if (gameState.hands[asker].includes(card)) {
      this.send({ type: 'error', message: "Can't ask for a card you have" });
      return;
    }

    let logMessage;
    if (gameState.hands[target].includes(card)) {
      // Transfer card
      gameState.hands[target] = gameState.hands[target].filter(c => c !== card);
      gameState.hands[asker].push(card);
      logMessage = `${asker} asked ${target} for ${card} - YES!`;
      // Same player continues
    } else {
      logMessage = `${asker} asked ${target} for ${card} - NO`;
      // Turn passes to target
      gameState.currentTurn = gameState.players.indexOf(target);
    }

    await this.storeGameState(data.gameCode, gameState);

    // Broadcast update to all players
    gameState.players.forEach(player => {
      this.sendToPlayer(player, {
        type: 'turnUpdate',
        gameState: this.getPlayerView(gameState, player),
        log: logMessage,
      });
    });
  }

  async makeClaim(data) {
    const gameState = await this.getGameState(data.gameCode);
    if (!gameState) return;

    const claimer = gameState.players[gameState.currentTurn];
    const claimerTeam = gameState.teams.team1.includes(claimer) ? 'team1' : 'team2';
    const suit = data.suit;
    const assignments = data.assignments;

    // Validate claim
    const halfSuits = this.getHalfSuits();
    const suitCards = halfSuits[suit];
    const assignedCards = Object.values(assignments).flat();

    let success = false;
    let logMessage;

    if (assignedCards.length === suitCards.length) {
      // Check if all cards are correctly assigned
      let allCorrect = true;
      for (const [player, cards] of Object.entries(assignments)) {
        for (const card of cards) {
          if (!gameState.hands[player]?.includes(card)) {
            allCorrect = false;
            break;
          }
        }
      }

      if (allCorrect) {
        // Check if all on one team
        const firstPlayerTeam = gameState.teams.team1.includes(Object.keys(assignments)[0]) ? 'team1' : 'team2';
        const allSameTeam = Object.keys(assignments).every(p => 
          (gameState.teams.team1.includes(p) && firstPlayerTeam === 'team1') ||
          (gameState.teams.team2.includes(p) && firstPlayerTeam === 'team2')
        );

        if (allSameTeam) {
          success = true;
          gameState.claimedSuits[claimerTeam].push(suit);
          
          // Remove cards from hands
          Object.entries(assignments).forEach(([player, cards]) => {
            gameState.hands[player] = gameState.hands[player].filter(c => !cards.includes(c));
          });
          
          logMessage = `${claimer} successfully claimed ${suit} for ${claimerTeam}!`;
        } else {
          // Wrong - opposite team gets it
          const oppositeTeam = claimerTeam === 'team1' ? 'team2' : 'team1';
          gameState.claimedSuits[oppositeTeam].push(suit);
          logMessage = `${claimer} failed claim on ${suit}. ${oppositeTeam} gets the suit!`;
        }
      } else {
        logMessage = `${claimer} incorrectly claimed ${suit}`;
      }
    } else {
      logMessage = `${claimer} failed to claim ${suit} - not all cards assigned`;
    }

    // Check for game end
    const totalClaimed = gameState.claimedSuits.team1.length + gameState.claimedSuits.team2.length;
    if (totalClaimed >= 8) {
      await this.endGame(gameState);
      return;
    }

    // Next turn
    gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
    
    await this.storeGameState(data.gameCode, gameState);

    // Broadcast update
    gameState.players.forEach(player => {
      this.sendToPlayer(player, {
        type: 'turnUpdate',
        gameState: this.getPlayerView(gameState, player),
        log: logMessage,
      });
    });
  }

  async endGame(gameState) {
    const t1Score = gameState.claimedSuits.team1.length;
    const t2Score = gameState.claimedSuits.team2.length;
    const winner = t1Score > t2Score ? 'Team 1' : t2Score > t1Score ? 'Team 2' : 'Tie';

    this.broadcast(gameState.code, {
      type: 'gameEnded',
      winner: winner,
      team1Score: t1Score,
      team2Score: t2Score,
    });

    // Clean up game after a delay
    setTimeout(() => this.deleteGameState(gameState.code), 300000); // 5 minutes
  }

  // Helper methods
  generateGameCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

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
    // Return game state with only the player's hand visible
    const view = { ...gameState };
    const playerHand = view.hands[playerName];
    view.hands = {};
    
    // Show card counts for other players
    gameState.players.forEach(p => {
      if (p === playerName) {
        view.hands[p] = playerHand;
      } else {
        view.hands[p] = new Array(gameState.hands[p].length);
      }
    });
    
    return view;
  }

  send(data) {
    this.ws.send(JSON.stringify(data));
  }

  sendToPlayer(playerName, data) {
    // In production, maintain WebSocket connections mapped to players
    // For now, send to current connection if it matches
    if (this.playerId === playerName) {
      this.send(data);
    }
  }

  broadcast(gameCode, data) {
    // In production, broadcast to all connections for this game
    // For now, just send to current connection
    this.send(data);
  }

  async storeGameState(gameCode, gameState) {
    // In production, use Durable Objects or KV storage
    // await this.env.GAMES.put(gameCode, JSON.stringify(gameState));
    
    // For demo, store in memory (won't persist)
    global.games = global.games || {};
    global.games[gameCode] = gameState;
  }

  async getGameState(gameCode) {
    // In production, retrieve from Durable Objects or KV
    // const data = await this.env.GAMES.get(gameCode);
    // return data ? JSON.parse(data) : null;
    
    // For demo, get from memory
    return global.games?.[gameCode] || null;
  }

  async deleteGameState(gameCode) {
    // await this.env.GAMES.delete(gameCode);
    if (global.games) {
      delete global.games[gameCode];
    }
  }

  handleDisconnect() {
    // Handle player disconnect
    console.log('Player disconnected:', this.playerId);
  }
}
