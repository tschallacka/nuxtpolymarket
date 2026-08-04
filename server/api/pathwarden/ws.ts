import { closePathwardenSession, handlePathwardenMessage, openPathwardenSession } from '#server/pathwarden/session'

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
        void openPathwardenSession(peer).catch(() => {
            peer.close(4401, 'Unauthorized Pathwarden session')
        })
    },
    message(peer, message) {
        handlePathwardenMessage(peer, message)
    },
    close(peer) {
        closePathwardenSession(peer)
    },
    error(peer) {
        closePathwardenSession(peer)
    }
})
