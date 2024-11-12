import { useState, useEffect } from "react";
import { json } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  TextField,
  Button,
  List,
  Spinner,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const orderNumber = formData.get("orderNumber");

  try {
    const orderResponse = await admin.graphql(
      `#graphql
      query getOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    name
                    quantity
                    variant {
                      sku
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
      { variables: { query: `name:${orderNumber}` } }
    );

    const orderData = await orderResponse.json();

    if (!orderData.data.orders.edges.length) {
      return json({ error: "Order not found" });
    }

    const foundOrder = orderData.data.orders.edges[0].node;

    return json({ order: foundOrder });
  } catch (error) {
    return json({ error: error.message });
  }
};

export default function OrderLookupPage() {
  const fetcher = useFetcher();
  const appBridge = useAppBridge();
  const [orderNumber, setOrderNumber] = useState("");
  const [enteredSkus, setEnteredSkus] = useState([]);
  const [currentSku, setCurrentSku] = useState("");

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const error = fetcher.data?.error;
  const order = fetcher.data?.order;

  const handleInputChange = (value) => {
    setOrderNumber(value);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    fetcher.submit({ orderNumber }, { method: "post" });
  };

  const handleSkuEntry = (event) => {
    event.preventDefault();
    if (!currentSku || !order) return;

    addSkuToEntered(currentSku);
    setCurrentSku("");
  };

  const addSkuToEntered = (sku) => {
    const itemToUpdate = order.lineItems.edges.find(
      ({ node }) =>
        node.variant.sku === sku &&
        enteredSkus.filter((enteredSku) => enteredSku === sku).length < node.quantity
    );

    if (itemToUpdate) {
      setEnteredSkus((prev) => [...prev, sku]);
    }
  };

  const allSkusEntered = order
    ? order.lineItems.edges.every(
        ({ node }) =>
          enteredSkus.filter((sku) => sku === node.variant.sku).length === node.quantity
      )
    : false;

  const handleCompleteOrder = () => {
    if (allSkusEntered && order) {
      const globalId = order.id;
      const numericId = globalId.split('/').pop();
      window.open(`shopify:admin/orders/${numericId}`, "_blank");
    }
  };

  // Automatically complete order once all SKUs are entered
  useEffect(() => {
    if (allSkusEntered) {
      handleCompleteOrder();
    }
  }, [enteredSkus]);

  return (
    <Page>
      <TitleBar title="Order Lookup" />

      <Layout>
        <Layout.Section>
          <Card sectioned>
            <form onSubmit={handleSubmit}>
              <TextField
                label="Order Number"
                value={orderNumber}
                onChange={handleInputChange}
                placeholder="Enter Order Number"
              />
              <Button primary submit disabled={isLoading}>
                {isLoading ? <Spinner size="small" /> : "Search Order"}
              </Button>
            </form>
          </Card>
        </Layout.Section>

        {error && (
          <Layout.Section>
            <Text color="critical">{error}</Text>
          </Layout.Section>
        )}

        {order && (
          <Layout.Section>
            <Card title={`Order #${order.name}`} sectioned>
              <form onSubmit={handleSkuEntry}>
                <TextField
                  label="Enter SKU"
                  value={currentSku}
                  onChange={(value) => setCurrentSku(value)}
                  placeholder="Scan or enter SKU"
                />
                <Button primary submit>
                  Enter SKU
                </Button>
              </form>
              <List>
                {order.lineItems.edges.map(({ node }) => (
                  <List.Item key={node.id}>
                    <Text>
                      {node.name} - SKU: {node.variant.sku} - Quantity: {node.quantity} - Entered SKUs:{" "}
                      {enteredSkus
                        .filter((sku) => sku === node.variant.sku)
                        .join(", ") || "None"}
                    </Text>
                    <Button onClick={() => addSkuToEntered(node.variant.sku)}>
                      Mark as packed
                    </Button>
                    {enteredSkus.filter((sku) => sku === node.variant.sku).length >=
                      node.quantity && (
                      <Text color="success">Completed</Text>
                    )}
                  </List.Item>
                ))}
              </List>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}