// Import order is load-bearing: otel must patch before anything pulls in the
// instrumented libraries, and the root module graph must finish loading before
// server-bootstrap's ChatService import — reversing that flips the resolution
// order of an import cycle and Nest sees `undefined` DI tokens at decoration
// time. Every composition root must follow this exact sequence.
import './otel'
import './sentry'
import { AppModule } from '@/app.module'
import { startApiServer } from './server-bootstrap'

startApiServer(AppModule)
