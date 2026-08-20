import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro:schema'

const docs = defineCollection({
    loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/docs' }),
    schema: z.object({
        title: z.string(),
        description: z.string(),
        order: z.number().default(99)
    })
})

const changelog = defineCollection({
    loader: glob({
        pattern: '**/*.{md,mdx}',
        base: './src/content/changelog'
    }),
    schema: z.object({
        version: z.string(),
        date: z.string()
    })
})

export const collections = { docs, changelog }
