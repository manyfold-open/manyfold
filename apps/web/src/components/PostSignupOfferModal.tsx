import type { FC } from 'react'

/* Editions slot. Open source has no billing and therefore no offer to make, so
   this renders nothing; the cloud build overlays the file with the modal a new
   account sees once, on its first visit to the workspace.

   It is mounted in the shell rather than opened from a page because the
   trigger is "first time here", not a route — and the shell is the one place
   that knows the workspace has finished its first paint. Same shape as
   `signup-gate/SignupGateModal`. */
const PostSignupOfferModal: FC = () => null

export default PostSignupOfferModal
