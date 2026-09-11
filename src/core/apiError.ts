/**
 * BJavaDecompiler
 * Copyright 2026 Jose Rodriguez <jrpcone@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Developer: Jose Rodriguez <jrpcone@gmail.com>
 */

/**
 * BJavaDecompiler - API Error class
 */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(msg: string): ApiError { return new ApiError(400, msg); }
  static unauthorized(msg: string = 'Unauthorized'): ApiError { return new ApiError(401, msg); }
  static forbidden(msg: string = 'Forbidden'): ApiError { return new ApiError(403, msg); }
  static notFound(msg: string = 'Not Found'): ApiError { return new ApiError(404, msg); }
  static conflict(msg: string): ApiError { return new ApiError(409, msg); }
  static internal(msg: string = 'Internal Server Error'): ApiError { return new ApiError(500, msg); }
}
