import { readonly, writable } from 'svelte/store';
import { toast } from 'svelte-sonner';

import { ENV_VARIABLES } from '../env';

// Enhanced WebSocket Manager with Auto-Reconnection
export class WebSocketManager {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // Start with 1 second
  private keepAliveInterval: number | null = null;
  private isReconnecting = false;
  private messageHandlers: ((data: string) => void)[] = [];

  // Connection state store
  private connectionState = writable<'connected' | 'connecting' | 'disconnected' | 'error'>('disconnected');
  public readonly connectionState$ = readonly(this.connectionState);

  constructor(private url: string) {
    this.setupVisibilityHandlers();
    this.connect();
  }

  private setupVisibilityHandlers() {
    // Handle page visibility changes
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.socket?.readyState !== WebSocket.OPEN) {
        console.log('Page became visible, attempting WebSocket reconnection...');
        this.reconnect();
      }
    });

    // Handle window focus
    window.addEventListener('focus', () => {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        console.log('Window focused, attempting WebSocket reconnection...');
        this.reconnect();
      }
    });

    // Handle online/offline events
    window.addEventListener('online', () => {
      console.log('Network came online, attempting WebSocket reconnection...');
      this.reconnect();
    });
  }

  public connect() {
    if (this.socket?.readyState === WebSocket.OPEN || this.isReconnecting) {
      return; // Already connected or reconnecting
    }

    this.isReconnecting = true;
    this.connectionState.set('connecting');

    try {
      this.socket = new WebSocket(this.url);
      this.setupEventListeners();
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      this.connectionState.set('error');
      this.handleReconnect();
    }
  }

  private setupEventListeners() {
    if (!this.socket) return;

    this.socket.addEventListener('open', () => {
      console.log('WebSocket connection opened');
      this.connectionState.set('connected');
      this.isReconnecting = false;
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000; // Reset delay

      toast.success('Connection', {
        duration: 3000,
        description: 'Connection established successfully',
      });

      // Start keep-alive
      this.startKeepAlive();
    });

    this.socket.addEventListener('close', event => {
      console.log('WebSocket connection closed:', event.code, event.reason);
      this.connectionState.set('disconnected');
      this.stopKeepAlive();

      if (!event.wasClean) {
        this.handleReconnect();
      }
    });

    this.socket.addEventListener('error', error => {
      console.error('WebSocket error:', error);
      this.connectionState.set('error');

      toast.error('Connection Error', {
        duration: 5000,
        description: 'Connection lost, attempting to reconnect...',
      });
    });

    this.socket.addEventListener('message', event => {
      this.messageHandlers.forEach(handler => handler(event.data));
    });
  }

  private handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      this.connectionState.set('error');
      this.isReconnecting = false;

      toast.error('Connection Failed', {
        duration: 0, // Persistent
        description: 'Unable to connect to the device. Please check your network.',
        action: {
          label: 'Retry',
          onClick: () => {
            this.reconnectAttempts = 0;
            this.reconnect();
          },
        },
      });
      return;
    }

    this.reconnectAttempts++;
    console.log(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);

    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff with jitter
    this.reconnectDelay = Math.min(this.reconnectDelay * 2 + Math.random() * 1000, 30000);
  }

  public reconnect() {
    this.close();
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;
    this.connect();
  }

  private startKeepAlive() {
    this.stopKeepAlive(); // Clear any existing interval

    this.keepAliveInterval = window.setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.send(JSON.stringify({ keepalive: null }));
      }
    }, 10000);
  }

  private stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  public send(data: string, onError?: () => void) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(data);
      } catch (error) {
        console.error('Failed to send message:', error);
        onError?.();
      }
    } else {
      console.warn('WebSocket not open, cannot send message');
      onError?.();
    }
  }

  public addMessageHandler(handler: (data: string) => void) {
    this.messageHandlers.push(handler);

    // Return unsubscribe function
    return () => {
      const index = this.messageHandlers.indexOf(handler);
      if (index > -1) {
        this.messageHandlers.splice(index, 1);
      }
    };
  }

  public close() {
    this.stopKeepAlive();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isReconnecting = false;
  }

  public getSocket() {
    return this.socket;
  }

  public isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}

// Create the enhanced WebSocket manager instance
const connectionUrl = `${ENV_VARIABLES.SOCKET_ENDPOINT}:${ENV_VARIABLES.SOCKET_PORT}`;
export const wsManager = new WebSocketManager(connectionUrl);

// Export connection state for components to use
export const connectionState = wsManager.connectionState$;
