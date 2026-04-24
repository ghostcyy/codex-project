import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { AuthService } from "./auth.service";
import type { AuthenticatedUser } from "./auth.types";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post("register")
  @Public()
  @HttpCode(HttpStatus.CREATED)
  register(@Body() body: Record<string, unknown>) {
    return this.authService.register(body);
  }

  @Post("login")
  @Public()
  @HttpCode(HttpStatus.OK)
  login(@Body() body: Record<string, unknown>) {
    return this.authService.login(body);
  }

  @Get("profile")
  @HttpCode(HttpStatus.OK)
  profile(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
