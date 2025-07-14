interface EnvVariables {
  SOCKET_ENDPOINT: string;
  SOCKET_PORT: string;
}

export const ENV_VARIABLES: EnvVariables = {
  SOCKET_ENDPOINT: getEnvVariable('SOCKET_ENDPOINT', `ws://${window.location.hostname}`),
  SOCKET_PORT: getEnvVariable('SOCKET_PORT', '80'),
};

function getEnvVariable(variable: 'SOCKET_ENDPOINT' | 'SOCKET_PORT', defaultValue: string): string {
  // Retrieve the value from the environment variables (prefixed with 'VITE_' in Vite)
  const envValue = import.meta.env[`VITE_${variable}`];

  // If in development mode and the environment variable is available, use it
  if (import.meta.env.MODE === 'development' && envValue) {
    return envValue;
  }

  // In production or when no env value is found, fallback to the provided default value
  return defaultValue;
}
