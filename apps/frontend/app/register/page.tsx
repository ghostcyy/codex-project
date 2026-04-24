import { redirect } from "next/navigation";
import { RegisterForm } from "../../components/auth/register-form";
import { getCurrentUser } from "../../lib/server-auth";

export default async function RegisterPage() {
  const user = await getCurrentUser();

  if (user) {
    redirect("/admin");
  }

  return (
    <div className="page-shell pb-12 pt-8">
      <section className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[0.86fr_1.14fr]">
        <div className="glass-panel reveal-up rounded-[38px] px-6 py-8 md:px-8">
          <div className="eyebrow">创建账号</div>
          <h1 className="display-title mt-5 text-4xl font-semibold md:text-5xl">为站点添加新成员</h1>
          <p className="mt-4 text-sm leading-7 text-[var(--muted)] md:text-base">
            注册完成后会自动绑定普通用户角色。后台管理权限仍然仅属于管理员或后续授权的编辑角色。
          </p>
          <div className="mt-6 secondary-card rounded-[26px] px-5 py-5 text-sm leading-7 text-[var(--muted)]">
            建议在本地阶段先创建测试账号，用于验证登录、权限限制和前后台访问流程。
          </div>
        </div>

        <div className="surface-card reveal-up rounded-[38px] px-6 py-8 md:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Register</p>
          <RegisterForm />
        </div>
      </section>
    </div>
  );
}
