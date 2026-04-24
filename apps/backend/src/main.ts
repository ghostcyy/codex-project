import "reflect-metadata";
import "./common/load-env";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3100";
  const port = Number(process.env.PORT ?? 4000);

  app.enableCors({
    origin: frontendOrigin,
    credentials: true
  });
  app.setGlobalPrefix("api");

  await app.listen(port);
  console.log(`API listening on http://localhost:${port}/api`);
}

void bootstrap();
