import { closePathwardenSession, handlePathwardenMessage, openPathwardenSession } from '#server/pathwarden/session'
import { recordPathwardenServerDebug } from '#server/pathwarden/debug-log'

export default defineWebSocketHandler({
    async upgrade(request) {
        // Nitro's production server supplies an absolute request URL, while
        // the Nuxt development websocket adapter may provide only the path.
        // A base keeps validation consistent in both transports.
        const url = new URL(request.url, 'http://pathwarden.invalid')
        if (!url.searchParams.get('runId')) {
            throw createError({ statusCode: 400, statusMessage: 'Pathwarden runId is required' })
        }
    },
    open(peer) {
        // Do not make the websocket handshake wait for database/world setup.
        // Nitro's dev adapter can otherwise leave the browser permanently in
        // CONNECTING while the async open hook is still resolving.
        void openPathwardenSession(peer).catch(error => {
            recordPathwardenServerDebug('socket.open_error', {
                peerId: peer.id,
                error: error instanceof Error ? error.message : String(error)
            })
            peer.close(4401, 'Unauthorized Pathwarden session')
        })
    },
    message(peer, message) {
        recordPathwardenServerDebug('websocket.message_hook', {
            peerId: peer.id,
            byteLength: message.uint8Array().byteLength
        })
        handlePathwardenMessage(peer, message)
    },
    close(peer) {
        recordPathwardenServerDebug('websocket.close_hook', { peerId: peer.id })
        closePathwardenSession(peer)
    },
    error(peer) {
        closePathwardenSession(peer)
    }
})
