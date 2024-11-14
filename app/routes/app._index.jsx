import { useState, useEffect, useRef } from "react";
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
  const completionTimestamp = formData.get("completionTimestamp");

  if (completionTimestamp) {
    // Tag the order with the timestamp as a note or metafield
    const updateOrderResponse = await admin.graphql(
      `#graphql
      mutation addCompletionTimestamp($id: ID!, $note: String!) {
        orderUpdate(input: { id: $id, note: $note }) {
          order {
            id
            note
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
      {
        variables: {
          id: orderNumber, // Assuming this is the global ID; adjust as needed
          note: `Order completed at: ${completionTimestamp}`,
        },
      }
    );

    return json({ success: true });
  }

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
  const skuInputRef = useRef(null);

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const error = fetcher.data?.error;
  const order = fetcher.data?.order;

  useEffect(() => {
    // Auto-focus SKU input after order is found
    if (order && skuInputRef.current) {
      skuInputRef.current.focus();
    }
  }, [order]);

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
        node.variant.sku.toLowerCase() === sku.toLowerCase() && // Make comparison case-insensitive
        enteredSkus.filter((enteredSku) => enteredSku.toLowerCase() === sku.toLowerCase()).length < node.quantity
    );
  
    if (itemToUpdate) {
      setEnteredSkus((prev) => [...prev, sku]);
    }
  };

  const getEnteredQuantity = (sku) =>
    enteredSkus.filter((enteredSku) => enteredSku.toLowerCase() === sku.toLowerCase()).length;

  const allSkusEntered = order
    ? order.lineItems.edges.every(
        ({ node }) => getEnteredQuantity(node.variant.sku) === node.quantity
      )
    : false;

    const handleCompleteOrder = () => {
      if (allSkusEntered && order) {
        const globalId = order.id;
        const numericId = globalId.split("/").pop();
        const completionTimestamp = new Date().toISOString();
    
        fetcher.submit(
          { orderNumber: globalId, completionTimestamp },
          { method: "post" }
        );
    
        window.open(`shopify:admin/orders/${numericId}`, "_blank");
    
        // Reset the page states
        setOrderNumber("");
        setEnteredSkus([]);
        setCurrentSku("");
        fetcher.load("/"); // reloads the page or refetches data
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
            {!order ? (
              <form onSubmit={handleSubmit}>
                <TextField
                  label="Order Number"
                  value={orderNumber}
                  onChange={handleInputChange}
                  placeholder="Enter Order Number"
                  autoFocus
                />
                <Button primary submit disabled={isLoading}>
                  {isLoading ? <Spinner size="small" /> : "Search Order"}
                </Button>
              </form>
            ) : (
              <form onSubmit={handleSkuEntry}>
                <TextField
                  label="Enter SKU"
                  value={currentSku}
                  onChange={(value) => setCurrentSku(value)}
                  placeholder="Scan or enter SKU"
                  ref={skuInputRef}
                  autoFocus
                />
                <Button primary submit>
                  Enter SKU
                </Button>
              </form>
            )}
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
              <List>
                {order.lineItems.edges.map(({ node }) => {
                  const enteredQuantity = getEnteredQuantity(node.variant.sku);
                  const isComplete = enteredQuantity >= node.quantity;
                  return (
                    <List.Item
                      key={node.id}
                      style={{
                        backgroundColor: isComplete ? "lightgreen" : "transparent",
                        padding: "10px",
                        borderRadius: "5px",
                        marginBottom: "5px",
                      }}
                    >
                      <Text>
                        {node.name} - SKU: {node.variant.sku} - Quantity:{" "}
                        {enteredQuantity}/{node.quantity}
                      </Text>
                      <Button onClick={() => addSkuToEntered(node.variant.sku)}>
                        Mark as packed
                      </Button>
                    </List.Item>
                  );
                })}
              </List>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}