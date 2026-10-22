import { Job } from "@opencode/schema/job"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { JobNotFoundError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const JobListQuery = Schema.Struct({
  ...LocationQuery.fields,
  sessionID: Session.ID.pipe(Schema.optional),
})

export const JobGroup = HttpApiGroup.make("server.job")
  .add(
    HttpApiEndpoint.get("job.list", "/api/job", {
      query: JobListQuery,
      success: Location.response(Schema.Array(Job.Summary)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "job.list",
          summary: "List background jobs",
          description:
            "List unified background jobs (shell commands and subagents) for a location, optionally filtered by owning session.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("job.get", "/api/job/:id", {
      params: { id: Schema.String },
      query: LocationQuery,
      success: Location.response(Job.Summary),
      error: JobNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "job.get",
          summary: "Get background job",
          description: "Get one unified background job by id (shell id or subagent child session id).",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("job.remove", "/api/job/:id", {
      params: { id: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "job.remove",
          summary: "Cancel and remove background job",
          description:
            "Terminate and remove one background job. Shell jobs are removed from the shell registry; subagent jobs are cancelled and their child session execution is interrupted.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "job", description: "Unified background job routes (shell + subagent)." }),
  )
