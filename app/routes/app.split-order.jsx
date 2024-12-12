import { useEffect, useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  List,
  TextField,
  Spinner,
  Checkbox,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

// Loader function to fetch orders with the tag "split this"
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const { admin } = await authenticate.admin(request);

  const fetchAllOrders = async (cursor = null, accumulatedOrders = []) => {
    const response = await admin.graphql(
      `#graphql
      query getOrdersWithTag($query: String!, $cursor: String) {
        orders(first: 250, query: $query, after: $cursor) {
          edges {
            cursor
            node {
              id
              name
              tags
              totalPrice
              createdAt
              lineItems(first: 250) {
                edges {
                  node {
                    id
                    name
                    quantity
                    variant {
                      id
                    }
                  }
                }
              }
              customer {
                id
                firstName
                lastName
                email
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      {
        variables: {
          query: 'status:open AND fulfillment_status:unfulfilled AND tag:"split this"',
          cursor: cursor,
        },
      }
    );

    const data = await response.json();
    if (data.errors) {
      console.error("Error fetching orders:", data.errors);
      throw new Error("Error fetching orders");
    }

    const newOrders = data.data.orders.edges.map((edge) => edge.node);
    const allOrders = [...accumulatedOrders, ...newOrders];

    if (data.data.orders.pageInfo.hasNextPage) {
      return fetchAllOrders(data.data.orders.pageInfo.endCursor, allOrders);
    }

    return allOrders;
  };

  try {
    const ordersWithTag = await fetchAllOrders();

    // Filter orders that do not end with "-S1" or "-S2"
    const filteredOrders = ordersWithTag.filter(
      (order) => !order.name.endsWith("-S1") && !order.name.endsWith("-S2")
    );

    return json({
      ordersWithTag: filteredOrders,
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    return json({ error: "Error fetching orders" });
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const orderNumber = formData.get("orderNumber");
  const splitOrder = formData.get("splitOrder") === "true";

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
                      id
                    }
                  }
                }
              }
              customer {
                id
                email
                firstName
                lastName
              }
              shippingAddress {
                address1
                address2
                city
                country
                zip
                province
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

    if (!splitOrder) {
      return json({ order: foundOrder });
    } else {
      const splitQuantities = JSON.parse(formData.get("splitQuantities"));

      const selectedItems = [];
      const unselectedItems = [];

      foundOrder.lineItems.edges.forEach((itemEdge) => {
        const item = itemEdge.node;
        const splitQuantity = splitQuantities[item.variant.id] || 0;

        if (splitQuantity > 0) {
          selectedItems.push({
            ...item,
            quantity: splitQuantity,
          });
        }

        const remainingQuantity = item.quantity - splitQuantity;
        if (remainingQuantity > 0) {
          unselectedItems.push({
            ...item,
            quantity: remainingQuantity,
          });
        }
      });

      if (unselectedItems.length === 0) {
        return json({
          error: "There are no items left to create the second order.",
        });
      }

      // Prepare line items with requiresShipping and priceSet
      const selectedLineItems = selectedItems.map((item) => ({
        variantId: item.variant.id,
        quantity: item.quantity,
        requiresShipping: true,
        priceSet: {
          shopMoney: {
            amount: "0.00",
            currencyCode: "USD",
          },
        },
      }));

      const unselectedLineItems = unselectedItems.map((item) => ({
        variantId: item.variant.id,
        quantity: item.quantity,
        requiresShipping: true,
        priceSet: {
          shopMoney: {
            amount: "0.00",
            currencyCode: "USD",
          },
        },
      }));

      const customerId = foundOrder.customer?.id;
      const customerInfo = {
        firstName: foundOrder.customer?.firstName || "",
        lastName: foundOrder.customer?.lastName || "",
      };
      const shippingAddress = foundOrder.shippingAddress;

      let newOrder1 = null;
      if (selectedLineItems.length > 0) {
        const orderCreateResponse1 = await admin.graphql(
          `#graphql
          mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
            orderCreate(order: $order, options: $options) {
              order {
                id
                name
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
              order: {
                name: `${orderNumber}-S1`,
                lineItems: selectedLineItems,
                customerId,
                shippingAddress: {
                  firstName: customerInfo.firstName,
                  lastName: customerInfo.lastName,
                  address1: shippingAddress.address1,
                  address2: shippingAddress.address2,
                  city: shippingAddress.city,
                  country: shippingAddress.country,
                  province: shippingAddress.province,
                  zip: shippingAddress.zip,
                },
                billingAddress: {
                  firstName: customerInfo.firstName,
                  lastName: customerInfo.lastName,
                  address1: shippingAddress.address1,
                  address2: shippingAddress.address2,
                  city: shippingAddress.city,
                  country: shippingAddress.country,
                  province: shippingAddress.province,
                  zip: shippingAddress.zip,
                },
                shippingLines: [
                  {
                    title: "Standard Shipping",
                    priceSet: {
                      shopMoney: {
                        amount: "0.00",
                        currencyCode: "USD",
                      },
                    },
                    code: "standard",
                    source: "Custom",
                  },
                ],
                financialStatus: "PAID",
                tags: [`Split Order: ${new Date().toISOString()}`],
              },
              options: {
                inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
                sendReceipt: true,
              },
            },
          }
        );

        const orderCreateData1 = await orderCreateResponse1.json();
        if (orderCreateData1.data.orderCreate.userErrors.length) {
          return json({
            error: orderCreateData1.data.orderCreate.userErrors
              .map((e) => e.message)
              .join(", "),
          });
        }

        newOrder1 = orderCreateData1.data.orderCreate.order;
      }

      let newOrder2 = null;
      if (unselectedLineItems.length > 0) {
        const orderCreateResponse2 = await admin.graphql(
          `#graphql
          mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
            orderCreate(order: $order, options: $options) {
              order {
                id
                name
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
              order: {
                name: `${orderNumber}-S2`,
                lineItems: unselectedLineItems,
                customerId,
                shippingAddress: {
                  firstName: customerInfo.firstName,
                  lastName: customerInfo.lastName,
                  address1: shippingAddress.address1,
                  address2: shippingAddress.address2,
                  city: shippingAddress.city,
                  country: shippingAddress.country,
                  province: shippingAddress.province,
                  zip: shippingAddress.zip,
                },
                billingAddress: {
                  firstName: customerInfo.firstName,
                  lastName: customerInfo.lastName,
                  address1: shippingAddress.address1,
                  address2: shippingAddress.address2,
                  city: shippingAddress.city,
                  country: shippingAddress.country,
                  province: shippingAddress.province,
                  zip: shippingAddress.zip,
                },
                shippingLines: [
                  {
                    title: "Standard Shipping",
                    priceSet: {
                      shopMoney: {
                        amount: "0.00",
                        currencyCode: "USD",
                      },
                    },
                    code: "standard",
                    source: "Custom",
                  },
                ],
                financialStatus: "PAID",
                tags: [`Split Order: ${new Date().toISOString()}`],
              },
              options: {
                inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
                sendReceipt: true,
              },
            },
          }
        );

        const orderCreateData2 = await orderCreateResponse2.json();
        if (orderCreateData2.data.orderCreate.userErrors.length) {
          return json({
            error: orderCreateData2.data.orderCreate.userErrors
              .map((e) => e.message)
              .join(", "),
          });
        }

        newOrder2 = orderCreateData2.data.orderCreate.order;
      }

      // Cancel the original order only if both orders are created
      const cancelOrderResponse = await admin.graphql(
        `#graphql
        mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!) {
          orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock) {
            job {
              id
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
            orderId: foundOrder.id,
            reason: "OTHER",
            refund: false,
            restock: true,
          },
        }
      );

      const cancelOrderData = await cancelOrderResponse.json();
      if (cancelOrderData.data.orderCancel.userErrors.length) {
        return json({
          error: cancelOrderData.data.orderCancel.userErrors
            .map((e) => e.message)
            .join(", "),
        });
      }

      return json({
        success: true,
        message: "Order split successfully",
        newOrder1,
        newOrder2,
      });
    }
  } catch (error) {
    return json({ error: error.message });
  }
};

export default function SplitOrderPage() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [orderNumber, setOrderNumber] = useState("");
  const [splitQuantities, setSplitQuantities] = useState({});
  const [isViewingOrderDetails, setIsViewingOrderDetails] = useState(false);
  const [ordersWithTag, setOrdersWithTag] = useState(data?.ordersWithTag || []);

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
    setIsViewingOrderDetails(true);
    fetcher.submit({ orderNumber }, { method: "POST" });
  };

  const handleQuantityChange = (variantId) => (value) => {
    setSplitQuantities((prev) => ({
      ...prev,
      [variantId]: parseInt(value, 10) || 0,
    }));
  };

  const handleSplitOrder = () => {
    fetcher.submit(
      {
        orderNumber,
        splitOrder: "true",
        splitQuantities: JSON.stringify(splitQuantities),
      },
      { method: "POST" }
    );
  };

  const handleBack = () => {
    setIsViewingOrderDetails(false);
    setOrderNumber("");
    setSplitQuantities({});
    fetcher.load("/"); // Reload the loader data
  };

  useEffect(() => {
    if (error) {
      shopify.toast.show(error);
    } else if (fetcher.data && fetcher.data.success) {
      shopify.toast.show(fetcher.data.message);
      setIsViewingOrderDetails(false);
      fetcher.load("/"); // Reload the loader data
    }
  }, [fetcher.data, error, shopify]);

  useEffect(() => {
    if (fetcher.data && fetcher.data.order) {
      setIsViewingOrderDetails(true);
    } else if (fetcher.data && fetcher.data.success) {
      setIsViewingOrderDetails(false);
    }
  }, [fetcher.data]);

  return (
    <Page>
      <TitleBar title="Split Order" />

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
              <Button primary submit>
                Search Order
              </Button>
            </form>
          </Card>
        </Layout.Section>
      </Layout>

      {isLoading && <Spinner accessibilityLabel="Loading order" size="large" />}

      {!isLoading && error && <Text color="critical">{error}</Text>}

      {isViewingOrderDetails && !isLoading && order && (
        <BlockStack gap="500">
          <Button onClick={handleBack}>Back to Order List</Button>
          <Card title={`Order #${order.name}`}>
            <List>
              {order.lineItems.edges.map((itemEdge) => {
                const item = itemEdge.node;
                return (
                  <List.Item key={item.id}>
                    <Text>{`${item.name} - Quantity: ${item.quantity}`}</Text>
                    <TextField
                      label="Quantity for First Order"
                      value={splitQuantities[item.variant.id] || ""}
                      onChange={handleQuantityChange(item.variant.id)}
                      placeholder="Enter quantity"
                      type="number"
                      min={0}
                      max={item.quantity}
                    />
                  </List.Item>
                );
              })}
            </List>
          </Card>
          <Button primary onClick={handleSplitOrder}>
            Split Order
          </Button>
        </BlockStack>
      )}

      {!isLoading && fetcher.data && fetcher.data.success && (
        <BlockStack gap="500">
          <Text>{fetcher.data.message}</Text>
          {fetcher.data.newOrder1 && (
            <Button
              primary
              onClick={() => {
                const orderId = fetcher.data.newOrder1.id.split("/").pop();
                window.open(`shopify:/admin/orders/${orderId}`, "_blank");
              }}
            >
              View New Order #{fetcher.data.newOrder1.name}
            </Button>
          )}
          {fetcher.data.newOrder2 && (
            <Button
              primary
              onClick={() => {
                const orderId = fetcher.data.newOrder2.id.split("/").pop();
                window.open(`shopify:/admin/orders/${orderId}`, "_blank");
              }}
            >
              View New Order #{fetcher.data.newOrder2.name}
            </Button>
          )}
        </BlockStack>
      )}

      {!isLoading && ordersWithTag.length > 0 && (
        <Card title='Orders with tag "split this"'>
          <List>
            {ordersWithTag.map((order) => (
              <List.Item key={order.id}>
                Order #{order.name} - {order.totalPrice} - Placed on:{" "}
                {new Date(order.createdAt).toLocaleDateString()}
                <Button
                  onClick={() => {
                    setOrderNumber(order.name);
                    fetcher.submit({ orderNumber: order.name }, { method: "POST" });
                  }}
                >
                  View Order
                </Button>
              </List.Item>
            ))}
          </List>
        </Card>
      )}
    </Page>
  );
}