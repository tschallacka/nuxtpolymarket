import { closePathwardenSession, handlePathwardenMessage, openPathwardenSession } from '#server/pathwarden/session'

export default defineWebSocketHandler({
    async upgrade(request) {
        const url = new URL(request.url)
        if (!url.searchParams.get('runId')) {
            throw createError({ statusCode: 400, statusMessage: 'Pathwarden runId is required' })
        }
    },
    async open(peer) {
        try {
            await openPathwardenSession(peer)
        } catch {
            peer.close(4401, 'Unauthorized Pathwarden session')
        }
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
