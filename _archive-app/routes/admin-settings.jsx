// refina/app/routes/admin-settings.jsx

import { json, redirect } from "@remix-run/node";
import { useLoaderData, Form } from "@remix-run/react";
import { getSession, commitSession } from "../utils/session.server";
import { getStoreSettings, saveStoreSettings } from "../lib/firebase.server";

export async function loader({ request }) {
  const session = await getSession(request.headers.get("Cookie"));
  const storeId = session.get("store_id");

  const settings = await getStoreSettings(storeId);
  return json({ category: settings?.category || "" });
}

export async function action({ request }) {
  const session = await getSession(request.headers.get("Cookie"));
  const storeId = session.get("store_id");

  const formData = await request.formData();
  const category = formData.get("category");

  await saveStoreSettings(storeId, { category });

  return redirect("/admin-settings");
}

export default function AdminSettings() {
  const { category } = useLoaderData();

  return (
    <div style={{ padding: 20 }}>
      <h1>Store Category Settings</h1>
      <Form method="post">
        <label>
          Product Category:
          <input type="text" name="category" defaultValue={category} />
        </label>
        <button type="submit">Save</button>
      </Form>
    </div>
  );
}

