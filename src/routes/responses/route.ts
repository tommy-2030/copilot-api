import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleResponse } from "./handler"

export const responseRoutes = new Hono()

responseRoutes.post("/", async (c) => {
  try {
    return await handleResponse(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
