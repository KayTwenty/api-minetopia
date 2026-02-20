import axios from 'axios'

/**
 * Send a command to the Node agent running on a game server.
 * All agent communication is internal (private network).
 */
export function agentClient(nodeIp: string, agentPort: number, agentToken: string) {
  return axios.create({
    baseURL: `http://${nodeIp}:${agentPort}`,
    headers: {
      Authorization: `Bearer ${agentToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  })
}
